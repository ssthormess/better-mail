import { and, asc, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, mailboxes, mailingListMembers } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { deleteUnreferencedRawMail, heldInboundKey, inboundStorageKey, mailboxInboundScope } from "@/lib/email/inbound-id";
import { resolveInboundAddress, resolveMailboxIdentity, type ResolvedList, type ResolvedMailbox } from "@/lib/email/routing";
import type { InboundQueueMessage } from "@/lib/email/inbound";

/**
 * Nested lists are expanded recursively, not just one level: a member address
 * that names another list contributes that list's members to the delivery set.
 * Each list records the restriction it was already expanded under, which both
 * makes a cycle (a -> b -> a, or a list subscribed to itself) a no-op instead
 * of a loop and lets a weaker restriction re-expand a list a held branch
 * consumed first; the depth cap bounds the member queries a pathological
 * chain can cost in one inbound delivery.
 */
const MAX_LIST_EXPANSION_DEPTH = 5;

/** One member mailbox a list copy is stored to, addressed as subscribed. */
export type MailingListDelivery = {
	/** The member email as stored on the (possibly nested) list, normalized. */
	address: string;
	mailbox: ResolvedMailbox;
};

export type SkippedListMember = {
	email: string;
	/** "external" also covers unparseable addresses and forward-only resolutions. */
	reason: "external" | "rejected" | "already-expanded" | "too-deep";
};

export type MailingListExpansion = {
	deliveries: MailingListDelivery[];
	skipped: SkippedListMember[];
	/**
	 * Lists whose own hold produced no deliverable reviewer — neither an owner
	 * member nor the list's owning user. The caller retains the raw object
	 * under `held/<listId>/` for each, so a held post is never silently
	 * discarded no matter how deeply the holding list is nested.
	 */
	retained: ResolvedList[];
};

/**
 * The restriction an expansion ran under. "restricted" means only owner-role
 * member rows were expanded (a held post's reviewer set); "full" means every
 * member row. Tracking it per list — separately from cycle prevention — is
 * what makes traversal order irrelevant: a list first expanded restricted
 * through a held branch is re-expanded in full when an unheld path reaches
 * it, while a list already expanded in full needs no restricted pass.
 */
type ExpansionRestriction = "restricted" | "full";

type ExpansionState = {
	skipped: SkippedListMember[];
	retained: ResolvedList[];
	/** listId -> the weakest restriction it has already been expanded under. */
	expanded: Map<string, ExpansionRestriction>;
	/** Lists whose own hold was already evaluated once — a held list never expands fully. */
	heldHandled: Set<string>;
};

/**
 * Resolves a mailing list into the member mailboxes that get a stored copy.
 * Each member email goes through the same inbound resolution a direct envelope
 * recipient would, so aliases, catch-alls and block rules behave identically.
 * The result is deduplicated by mailbox: two member rows that resolve to the
 * same mailbox (say, an address and its alias) deliver exactly one copy.
 *
 * `ownersOnly` marks the whole delivery as held for review: expansion is
 * restricted to owner members, the reviewers. A nested list that would hold
 * the sender's post itself is a held branch — it expands its own reviewers
 * privately and gets the complete no-reviewer handling: it keeps a sole
 * reviewer past sender suppression, falls back to its own list's owning user,
 * and is reported in `retained` when even that fails, all without disturbing
 * ordinary deliveries from sibling branches.
 *
 * The delivery set is a union over expansion branches, and traversal order
 * cannot change it: a member reached only through a restricted branch is
 * restricted, while the same member reached through an unheld sibling branch
 * still receives the post — expansion state is tracked per list so the
 * weaker restriction wins rather than whichever ran first. Skipped members
 * are reported, never subtracted — which branch a mailbox came through
 * cannot make another branch's copy undeliverable.
 */
export async function expandMailingListDeliveries(
	db: AppDatabase,
	list: ResolvedList,
	envelopeFrom?: string | null,
	options: { ownersOnly?: boolean } = {},
): Promise<MailingListExpansion> {
	const ownersOnly = options.ownersOnly ?? false;
	// Ordinary deliveries and reviewer deliveries are collected apart so echo
	// suppression — which only ever applies to an unheld delivery — can never
	// strip a held branch's reviewer copy.
	const ordinary = new Map<string, MailingListDelivery>();
	const reviewer = new Map<string, MailingListDelivery>();
	const state: ExpansionState = {
		skipped: [],
		retained: [],
		expanded: new Map([[list.listId, ownersOnly ? "restricted" : "full"]]),
		heldHandled: new Set(ownersOnly ? [list.listId] : []),
	};
	const senderMailbox = await resolveMailboxIdentity(db, envelopeFrom ?? "");
	await collectMemberDeliveries(db, list.listId, envelopeFrom, state, ordinary, reviewer, 0, ownersOnly, senderMailbox);

	// Sender dedup: a member posting to the list does not get a copy of their
	// own post, whether their member row uses the address they sent from or an
	// alias of the same mailbox. The identity lookup — not the delivery
	// resolver — decides whose mailbox the sender owns, so a catch-all cannot
	// fold an unrelated sender onto a member mailbox and suppress their copy.
	// Suppression touches ordinary deliveries only: a held post's reviewers
	// are the moderation notice, and for a held post it applies only while
	// another reviewer remains — echo-free delivery must not leave a held
	// post with nobody who can act on it.
	if (senderMailbox && (!ownersOnly || ordinary.size + reviewer.size > 1)) {
		ordinary.delete(senderMailbox.mailboxId);
	}

	if (ownersOnly && !ordinary.size && !reviewer.size) {
		// A held post must land with a reviewer: when no owner member resolves,
		// the list's owning user's mailbox is the reviewer of last resort.
		const fallback = await resolveFallbackReviewer(db, list);
		if (fallback) {
			reviewer.set(fallback.mailboxId, { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback });
		} else {
			state.retained.push(list);
		}
	}

	// A mailbox reachable both ways keeps the ordinary subscription copy.
	const deliveries = new Map(ordinary);
	for (const [mailboxId, delivery] of reviewer) {
		if (!deliveries.has(mailboxId)) deliveries.set(mailboxId, delivery);
	}
	return { deliveries: [...deliveries.values()], skipped: state.skipped, retained: state.retained };
}

/**
 * The reviewer of last resort for a held post: the list's owning user's
 * mailbox, preferring one on the list's domain but accepting any of their
 * mailboxes — the point is only that a held copy reaches someone who can act
 * on it. This is a notice destination, not a reviewer identity: the fallback
 * mailbox need not be a member of the list at all, so its owner seeing the
 * held copy does not by itself provide an approve path — approval still takes
 * an unmoderated owner reposting, or an operator acting on a `held/` object.
 * Returns null when the owning user has no enabled mailbox at all; the caller
 * then retains the raw object instead of delivering.
 */
async function resolveFallbackReviewer(
	db: AppDatabase,
	list: ResolvedList,
): Promise<ResolvedMailbox | null> {
	const rows = await db
		.select({ mailbox: mailboxes, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(mailboxes.userId, list.userId), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt));
	const pick = rows.find((row) => row.mailbox.domainId === list.domainId) ?? rows[0];
	if (!pick) return null;
	return {
		mailboxId: pick.mailbox.id,
		folderId: null,
		userId: pick.mailbox.userId,
		domainId: pick.mailbox.domainId,
		localPart: pick.mailbox.localPart,
		hostname: pick.hostname,
		displayName: pick.mailbox.displayName,
	};
}

async function collectMemberDeliveries(
	db: AppDatabase,
	listId: string,
	envelopeFrom: string | null | undefined,
	state: ExpansionState,
	target: Map<string, MailingListDelivery>,
	heldTarget: Map<string, MailingListDelivery>,
	depth: number,
	ownersOnly: boolean,
	senderMailbox: ResolvedMailbox | null,
): Promise<void> {
	const members = await db
		.select({ email: mailingListMembers.email })
		.from(mailingListMembers)
		.where(and(eq(mailingListMembers.listId, listId), ...(ownersOnly ? [eq(mailingListMembers.role, "owner")] : [])));

	for (const member of members) {
		const decision = await resolveInboundAddress(db, member.email, envelopeFrom);
		if (decision?.mailbox) {
			if (!target.has(decision.mailbox.mailboxId)) {
				target.set(decision.mailbox.mailboxId, { address: normalizeEmailAddress(member.email), mailbox: decision.mailbox });
			}
			continue;
		}
		if (decision?.action === "list" && decision.list) {
			const child = decision.list;
			if (decision.heldForModeration) {
				// A list that would itself hold this post is a held branch: it is
				// evaluated once, privately, and gets the same no-reviewer
				// guarantee the root held post gets — its own sole-reviewer
				// protection, its own owner's fallback mailbox, and its own
				// `held/` retention — no matter which branch reached it first
				// or what else delivered normally.
				if (state.heldHandled.has(child.listId)) {
					state.skipped.push({ email: member.email, reason: "already-expanded" });
					continue;
				}
				state.heldHandled.add(child.listId);
				if (depth + 1 >= MAX_LIST_EXPANSION_DEPTH) {
					// The reviewers are unreachable, so retain rather than skip.
					state.retained.push(child);
					continue;
				}
				markExpanded(state, child.listId, "restricted");
				// Reviewer copies nested held branches contribute live apart from
				// the child's own deliveries, so suppression below cannot strip a
				// reviewer a sub-branch already decided to keep.
				const branch = new Map<string, MailingListDelivery>();
				const branchHeld = new Map<string, MailingListDelivery>();
				await collectMemberDeliveries(db, child.listId, envelopeFrom, state, branch, branchHeld, depth + 1, true, senderMailbox);
				if (senderMailbox && branch.size + branchHeld.size > 1) branch.delete(senderMailbox.mailboxId);
				if (!branch.size && !branchHeld.size) {
					const fallback = await resolveFallbackReviewer(db, child);
					if (fallback) {
						branch.set(fallback.mailboxId, { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback });
					} else {
						state.retained.push(child);
						continue;
					}
				}
				for (const [mailboxId, delivery] of branchHeld) {
					if (!heldTarget.has(mailboxId)) heldTarget.set(mailboxId, delivery);
				}
				for (const [mailboxId, delivery] of branch) {
					if (!heldTarget.has(mailboxId)) heldTarget.set(mailboxId, delivery);
				}
				continue;
			}
			const desired: ExpansionRestriction = ownersOnly ? "restricted" : "full";
			const seen = state.expanded.get(child.listId);
			if (seen === "full" || (seen === "restricted" && desired === "restricted")) {
				state.skipped.push({ email: member.email, reason: "already-expanded" });
				continue;
			}
			if (depth + 1 >= MAX_LIST_EXPANSION_DEPTH) {
				state.skipped.push({ email: member.email, reason: "too-deep" });
				continue;
			}
			markExpanded(state, child.listId, desired);
			await collectMemberDeliveries(db, child.listId, envelopeFrom, state, target, heldTarget, depth + 1, ownersOnly, senderMailbox);
			continue;
		}
		state.skipped.push({ email: member.email, reason: decision?.action === "reject" ? "rejected" : "external" });
	}
}

function markExpanded(state: ExpansionState, listId: string, restriction: ExpansionRestriction): void {
	if (state.expanded.get(listId) !== "full") state.expanded.set(listId, restriction);
}

/**
 * Fans a list-addressed inbound message out to every resolved member mailbox.
 * Each member gets their own copy of the raw MIME under their mailbox-scoped
 * storage key, so the queue's `(mailboxId, rawR2Key)` dedup keeps queue retries
 * idempotent, a direct copy of the same message dedupes the member's list copy,
 * and one member deleting their copy cannot drop the object under the others.
 *
 * Which list an envelope recipient names is decided in resolveInboundAddress:
 * exact tagged list > enabled alias paths > base list. A stored `team+x`
 * claims `team+x@domain` ahead of the enabled `team` mailbox and alias
 * claims; `team+x` falls back to the `team` list only when no `team+x` list
 * exists. An empty-tag `team+@domain` is literal-only for lists — only a
 * stored `team+` claims it, never the `team` base — matching how the
 * plus-addressing pass treats empty tags; a tag that itself ends in `+`
 * (`team++`, `team+x+`) is non-empty and falls back to `team` normally. On
 * this base the mailbox claims
 * still strip `+` to base, so `team+` mail lands in the `team` mailbox when
 * no `team+` claimant exists; the divergence disappears once #416 merges.
 *
 * A member copy carries the member's own subscribed address as its envelope
 * recipient (`payload.to` = member address), never the list's — a member
 * subscribed as `bob+lists@domain` re-resolves and stores under
 * `bob+lists@domain`, so member-side tag rules see the member's own `+lists`
 * tag. A tag on the list address (`team+x`) is list-routing metadata only and
 * never reaches member rules.
 *
 * External members (an address no hosted domain resolves) are skipped, not
 * forwarded: the outbound queue only sends from user-owned mailbox identities,
 * and correct off-instance list forwarding (envelope sender rewriting, posting
 * rules) belongs to a later slice.
 *
 * A member failure does not lose the sibling deliveries: every member is
 * attempted, then the first error is rethrown so the queue retry replays the
 * payload — already-stored members are skipped by the storage-key dedup.
 *
 * A post the routing decision held for review (`ownersOnly`) goes only to the
 * list's owner members — the reviewers — instead of the full membership. The
 * reviewer copy is the moderation notice: an owner approves by reposting the
 * message to the list, which a list-level `moderated` flag does not re-hold
 * because owner senders are exempt from it. A member-level `moderated` flag
 * is honored at every role, so a moderated owner's repost is re-held for the
 * remaining owners — approve-via-repost needs at least one unmoderated owner,
 * with the `held/` object as the operator fallback when none exists.
 *
 * Every held branch — the root list or a nested list that holds the post —
 * gets a reviewer: its owner members, then its owning user's mailbox as a
 * notice-only destination, then retention under `held/<listId>/<hash>.eml`.
 * Retained objects sit outside the `inbound/` sweep and are operator-
 * recoverable from the bucket only — no in-app replay exists yet, and
 * bounded retention plus operator alerting are deferred to the
 * approve/discard-queue slice. A list with no reachable reviewer
 * accepts-and-holds rather than bouncing: the sender sees silence either
 * way today, and a recoverable copy beats a bounce for a post the list
 * owner may still want. A real pending-posts queue is a later slice.
 */
export async function deliverToMailingList(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	list: ResolvedList,
	deliver: (payload: InboundQueueMessage, mailbox: ResolvedMailbox) => Promise<void>,
	options: { ownersOnly?: boolean } = {},
): Promise<void> {
	const db = getDb(env);
	const { deliveries, skipped, retained } = await expandMailingListDeliveries(db, list, payload.from, options);
	if (options.ownersOnly) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: post from ${payload.from} held for owner review`);
	}
	if (skipped.length) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: skipped ${skipped.map((member) => `${member.email} (${member.reason})`).join(", ")}`);
	}
	if (!deliveries.length && !retained.length) {
		console.warn(`Mailing list ${list.localPart}@${list.hostname} has no deliverable members`);
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}
	const buffer = await raw.arrayBuffer();

	// A held branch with no reviewer must never vanish silently: retain the
	// raw under a content-keyed `held/` object per holding list (retries
	// idempotent) where ops or a later moderation surface can recover it.
	for (const heldList of retained) {
		const heldKey = await heldInboundKey(heldList.listId, buffer);
		await env.BUCKET.put(heldKey, buffer, {
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: { from: payload.from, to: payload.to },
		});
		console.warn(`Mailing list ${heldList.localPart}@${heldList.hostname}: held post retained at ${heldKey} — no reviewer could receive it`);
	}
	if (!deliveries.length) {
		await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
		return;
	}

	let firstError: unknown = null;
	for (const delivery of deliveries) {
		const rawR2Key = await inboundStorageKey(buffer, mailboxInboundScope(delivery.mailbox.mailboxId));
		await env.BUCKET.put(rawR2Key, buffer, {
			httpMetadata: { contentType: "message/rfc822" },
			customMetadata: { from: payload.from, to: delivery.address },
		});
		try {
			await deliver({ ...payload, to: delivery.address, rawR2Key }, delivery.mailbox);
		} catch (error) {
			console.error(`Mailing list delivery to ${delivery.address} failed`, error);
			firstError ??= error;
		}
	}
	// Keep the source object while any member still needs the retry; once every
	// member's own copy is stored the original is unreferenced.
	if (firstError) throw firstError;
	await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
}
