import { and, asc, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, mailboxes, mailingListMembers } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { deleteUnreferencedRawMail, heldInboundKey, inboundStorageKey, mailboxInboundScope } from "@/lib/email/inbound-id";
import { resolveInboundAddress, resolveMailboxIdentity, type ResolvedList, type ResolvedMailbox } from "@/lib/email/routing";
import type { InboundQueueMessage } from "@/lib/email/inbound";

/**
 * Nested lists are expanded recursively, not just one level: a member address
 * that names another list contributes that list's members to the delivery
 * set. Expansions are cached as results rather than visited flags — cycle
 * detection lives on the DFS stack — and the depth cap bounds the member
 * queries a pathological chain can cost in one inbound delivery. Moderation
 * applies only to the directly-addressed list: a nested list always expands
 * as ordinary members, its own `moderated` flag and its member rows' flags
 * ignored. Propagating holds through nesting is a deferred slice — making
 * per-branch reviewer resolution order-independent under shared subtrees,
 * cycles and the depth cap proved unsound.
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
	 * Lists whose hold produced no deliverable reviewer — neither an owner
	 * member nor the list's owning user. Only the directly-addressed list
	 * can hold today, so this carries at most that one list; the caller
	 * retains the raw object under `held/<listId>/` so a held post is never
	 * silently discarded.
	 */
	retained: ResolvedList[];
};

/**
 * The member-row filter a scan ran under. "restricted" — used only for the
 * directly-addressed list of a held post — expands owner-role rows, the
 * reviewers. Everything beneath that first scan expands "full": restriction
 * never propagates into nesting, so a cached result is always the ordinary
 * one and a nested list's own moderation flags are ignored entirely.
 */
type ExpansionRestriction = "restricted" | "full";

type ExpansionState = {
	skipped: SkippedListMember[];
	skippedKeys: Set<string>;
	/**
	 * listId -> computed ordinary expansion, each carrying its compute
	 * depth. Only full results are cached: the single restricted query a
	 * delivery ever runs is the root's own scan, and it is never reused.
	 */
	expansions: Map<string, { depth: number; entries: Map<string, MailingListDelivery> }>;
	/** The DFS stack — pure cycle detection; it owns no delivery state. */
	computing: Set<string>;
	senderMailbox: ResolvedMailbox | null;
};

/**
 * Resolves a mailing list into the member mailboxes that get a stored copy.
 * Each member email goes through the same inbound resolution a direct envelope
 * recipient would, so aliases, catch-alls and block rules behave identically.
 * The result is deduplicated by mailbox: two member rows that resolve to the
 * same mailbox (say, an address and its alias) deliver exactly one copy.
 *
 * `ownersOnly` marks the whole delivery as held for review: the root scan
 * expands only owner-role member rows, the reviewers. Moderation stops at
 * the addressed list — a member row that names another list expands it as
 * ordinary members even inside the restricted scan, so an owner-list member
 * contributes its full membership, and a nested list's own `moderated`
 * flags are ignored while nested. Propagating holds through nesting is a
 * deferred slice: making per-branch reviewer resolution order-independent
 * under shared subtrees, cycles and the depth cap proved unsound, so today
 * a nested moderated list delivers as ordinary members.
 *
 * The delivery set is a union over expansion branches, and traversal order
 * cannot change it: expansions are cached as results, not visited flags,
 * so the same list reached twice delivers the same members, and a shallow
 * reach recomputes what a deep one truncated at the cap. Skipped members
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
	const state: ExpansionState = {
		skipped: [],
		skippedKeys: new Set(),
		expansions: new Map(),
		computing: new Set(),
		senderMailbox: await resolveMailboxIdentity(db, envelopeFrom ?? ""),
	};
	const { entries } = await expandList(db, list.listId, envelopeFrom, state, ownersOnly ? "restricted" : "full", 0);
	const deliveries = new Map(entries);

	// Sender dedup: a member posting to the list does not get a copy of their
	// own post, whether their member row uses the address they sent from or an
	// alias of the same mailbox. The identity lookup — not the delivery
	// resolver — decides whose mailbox the sender owns, so a catch-all cannot
	// fold an unrelated sender onto a member mailbox and suppress their copy.
	// For a held post the reviewers are the moderation notice, so suppression
	// applies only while another reviewer remains — echo-free delivery must
	// not leave a held post with nobody who can act on it.
	if (state.senderMailbox && (!ownersOnly || deliveries.size > 1)) {
		deliveries.delete(state.senderMailbox.mailboxId);
	}

	// A held post must land with a reviewer: when no owner member resolves,
	// the list's owning user's mailbox is the reviewer of last resort, and
	// when even that fails the raw is retained under `held/<listId>/`.
	const retained: ResolvedList[] = [];
	if (ownersOnly && !deliveries.size) {
		const fallback = await resolveFallbackReviewer(db, list);
		if (fallback) {
			deliveries.set(fallback.mailboxId, { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback });
		} else {
			retained.push(list);
		}
	}
	return { deliveries: [...deliveries.values()], skipped: state.skipped, retained };
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

function pushSkipped(state: ExpansionState, email: string, reason: SkippedListMember["reason"]): void {
	const key = `${reason}${email}`;
	if (state.skippedKeys.has(key)) return;
	state.skippedKeys.add(key);
	state.skipped.push({ email, reason });
}

function mergeDelivery(entries: Map<string, MailingListDelivery>, delivery: MailingListDelivery): void {
	if (!entries.has(delivery.mailbox.mailboxId)) entries.set(delivery.mailbox.mailboxId, delivery);
}

/**
 * Computes (or reuses) a list's ordinary member expansion. Caching stores
 * the result, not a visited flag: a cached entry serves any query at equal
 * or greater depth, and a shallower query recomputes for the richer result
 * — the cache converges to the union of every path. A list on the current
 * DFS stack contributes nothing to the caller (its ancestor scan already
 * owns it), and past the depth cap a member list resolves only from cache.
 * `restricted` exists for the root scan of a held post only — it filters
 * the member query to owner rows — and is never propagated or cached.
 */
async function expandList(
	db: AppDatabase,
	listId: string,
	envelopeFrom: string | null | undefined,
	state: ExpansionState,
	restriction: ExpansionRestriction,
	depth: number,
): Promise<{ entries: Map<string, MailingListDelivery>; blocked: "cycle" | "depth" | null }> {
	const cached = restriction === "full" ? state.expansions.get(listId) : undefined;
	if (cached && cached.depth <= depth) return { entries: cached.entries, blocked: null };
	if (state.computing.has(listId)) return { entries: new Map(), blocked: "cycle" };
	if (depth >= MAX_LIST_EXPANSION_DEPTH) return { entries: new Map(), blocked: "depth" };

	state.computing.add(listId);
	try {
		const entries = new Map<string, MailingListDelivery>();
		const members = await db
			.select({ email: mailingListMembers.email, role: mailingListMembers.role })
			.from(mailingListMembers)
			.where(and(eq(mailingListMembers.listId, listId), ...(restriction === "restricted" ? [eq(mailingListMembers.role, "owner")] : [])));

		for (const member of members) {
			const decision = await resolveInboundAddress(db, member.email, envelopeFrom);
			if (decision?.mailbox) {
				mergeDelivery(entries, { address: normalizeEmailAddress(member.email), mailbox: decision.mailbox });
				continue;
			}
			if (decision?.action === "list" && decision.list) {
				// A member row that names another list always expands as
				// ordinary members: a nested list's own moderation flags
				// (`heldForModeration`, member-level flags) do not apply here —
				// moderation is decided only for the addressed list, and a
				// posting decision can still reject the whole branch.
				const childResult = await expandList(db, decision.list.listId, envelopeFrom, state, "full", depth + 1);
				if (childResult.blocked) {
					pushSkipped(state, member.email, childResult.blocked === "cycle" ? "already-expanded" : "too-deep");
					continue;
				}
				for (const entry of childResult.entries.values()) mergeDelivery(entries, entry);
				continue;
			}
			pushSkipped(state, member.email, decision?.action === "reject" ? "rejected" : "external");
		}
		if (restriction === "full") state.expansions.set(listId, { depth, entries });
		return { entries, blocked: null };
	} finally {
		state.computing.delete(listId);
	}
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
 * remaining owners — approve-via-repost needs at least one unmoderated owner.
 * A list that moderates every owner row still delivers the reviewer copies;
 * it just has no built-in approval path — every repost re-holds, so clearing
 * the hold takes an operator acting on a delivered copy or unflagging a row.
 *
 * A held post — only the directly-addressed list can hold one — always gets
 * a reviewer: its owner members, then its owning user's mailbox as a
 * notice-only destination, then retention under `held/<listId>/<hash>.eml`.
 * Retained objects sit outside the `inbound/` sweep and are operator-
 * recoverable from the bucket only — no in-app replay exists yet, and
 * bounded retention plus operator alerting are deferred to the
 * approve/discard-queue slice. A list with no reachable reviewer
 * accepts-and-holds rather than bouncing: an SMTP-level reject is only
 * available while the message is still being received, and by fan-out time
 * the choice is keep-or-drop — a recoverable `held/` copy beats silently
 * dropping a post the list owner may still want. A real pending-posts
 * queue is a later slice.
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
