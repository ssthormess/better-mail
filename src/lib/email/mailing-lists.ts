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
 * A visited set of list ids makes a cycle (a -> b -> a, or a list subscribed to
 * itself) a no-op instead of a loop, and the depth cap bounds the member
 * queries a pathological chain can cost in one inbound delivery.
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
};

/**
 * Resolves a mailing list into the member mailboxes that get a stored copy.
 * Each member email goes through the same inbound resolution a direct envelope
 * recipient would, so aliases, catch-alls and block rules behave identically.
 * The result is deduplicated by mailbox: two member rows that resolve to the
 * same mailbox (say, an address and its alias) deliver exactly one copy.
 *
 * `ownersOnly` restricts the expansion to `owner` members — the delivery set
 * for a post held for review. It propagates through nested lists, and a nested
 * list that would itself hold the sender's post also restricts that branch to
 * its owners, so a held post only ever reaches mailboxes that can review it.
 *
 * The delivery set is a union over expansion branches, not traversal order:
 * a mailbox deliverable through any branch gets the copy, so a member reached
 * only through a held branch is skipped while the same member reached through
 * an unheld sibling branch still receives the post. Skipped members are
 * reported, never subtracted — which branch a mailbox came through cannot
 * make another branch's copy undeliverable.
 */
export async function expandMailingListDeliveries(
	db: AppDatabase,
	list: ResolvedList,
	envelopeFrom?: string | null,
	options: { ownersOnly?: boolean } = {},
): Promise<MailingListExpansion> {
	const deliveries = new Map<string, MailingListDelivery>();
	const skipped: SkippedListMember[] = [];
	await collectMemberDeliveries(db, list.listId, envelopeFrom, deliveries, skipped, new Set([list.listId]), 0, options.ownersOnly ?? false);

	// Sender dedup: a member posting to the list does not get a copy of their
	// own post, whether their member row uses the address they sent from or an
	// alias of the same mailbox. The identity lookup — not the delivery
	// resolver — decides whose mailbox the sender owns, so a catch-all cannot
	// fold an unrelated sender onto a member mailbox and suppress their copy.
	// For a held post the reviewers are the deliveries: suppression only
	// applies while at least one other reviewer remains, since echo-free
	// delivery must not leave a held post with nobody who can act on it.
	const senderMailbox = await resolveMailboxIdentity(db, envelopeFrom ?? "");
	if (senderMailbox && (!options.ownersOnly || deliveries.size > 1)) {
		deliveries.delete(senderMailbox.mailboxId);
	}

	if (options.ownersOnly && !deliveries.size) {
		// A held post must land with a reviewer: when no owner member resolves,
		// the list's owning user's mailbox is the reviewer of last resort.
		const fallback = await resolveFallbackReviewer(db, list);
		if (fallback) deliveries.set(fallback.mailboxId, { address: `${fallback.localPart}@${fallback.hostname}`, mailbox: fallback });
	}

	return { deliveries: [...deliveries.values()], skipped };
}

/**
 * The reviewer of last resort for a held post: the list's owning user's
 * mailbox, preferring one on the list's domain but accepting any of their
 * mailboxes — the point is only that a held copy reaches someone who can act
 * on it. Returns null when the owner has no enabled mailbox at all; the caller
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
	deliveries: Map<string, MailingListDelivery>,
	skipped: SkippedListMember[],
	visitedListIds: Set<string>,
	depth: number,
	ownersOnly: boolean,
): Promise<void> {
	const members = await db
		.select({ email: mailingListMembers.email })
		.from(mailingListMembers)
		.where(and(eq(mailingListMembers.listId, listId), ...(ownersOnly ? [eq(mailingListMembers.role, "owner")] : [])));

	for (const member of members) {
		const decision = await resolveInboundAddress(db, member.email, envelopeFrom);
		if (decision?.mailbox) {
			deliveries.set(decision.mailbox.mailboxId, { address: normalizeEmailAddress(member.email), mailbox: decision.mailbox });
			continue;
		}
		if (decision?.action === "list" && decision.list) {
			if (visitedListIds.has(decision.list.listId)) {
				skipped.push({ email: member.email, reason: "already-expanded" });
				continue;
			}
			if (depth + 1 >= MAX_LIST_EXPANSION_DEPTH) {
				skipped.push({ email: member.email, reason: "too-deep" });
				continue;
			}
			visitedListIds.add(decision.list.listId);
			await collectMemberDeliveries(db, decision.list.listId, envelopeFrom, deliveries, skipped, visitedListIds, depth + 1, ownersOnly || !!decision.heldForModeration);
			continue;
		}
		skipped.push({ email: member.email, reason: decision?.action === "reject" ? "rejected" : "external" });
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
 * reviewer copy is the moderation notice: an owner approves by reposting or
 * forwarding the message to the list, which a list-level `moderated` flag
 * does not re-hold because owner senders are exempt from it (a member-level
 * `moderated` flag on the owner still holds). When no owner member resolves,
 * the list's owning user's mailbox reviews it; when even that fails, the raw
 * is retained under `held/` so the post is never silently discarded. A real
 * pending-posts queue with approve/discard is a later slice.
 */
export async function deliverToMailingList(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	list: ResolvedList,
	deliver: (payload: InboundQueueMessage, mailbox: ResolvedMailbox) => Promise<void>,
	options: { ownersOnly?: boolean } = {},
): Promise<void> {
	const db = getDb(env);
	const { deliveries, skipped } = await expandMailingListDeliveries(db, list, payload.from, options);
	if (options.ownersOnly) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: post from ${payload.from} held for owner review`);
	}
	if (skipped.length) {
		console.info(`Mailing list ${list.localPart}@${list.hostname}: skipped ${skipped.map((member) => `${member.email} (${member.reason})`).join(", ")}`);
	}
	if (!deliveries.length) {
		if (options.ownersOnly) {
			// A held post must never vanish silently: retain the raw under a
			// content-keyed `held/` object (retries idempotent) where ops or a
			// later moderation surface can recover it.
			const raw = await env.BUCKET.get(payload.rawR2Key);
			if (!raw) {
				console.error(`Missing R2 object: ${payload.rawR2Key}`);
				return;
			}
			const buffer = await raw.arrayBuffer();
			const heldKey = await heldInboundKey(list.listId, buffer);
			await env.BUCKET.put(heldKey, buffer, {
				httpMetadata: { contentType: "message/rfc822" },
				customMetadata: { from: payload.from, to: payload.to },
			});
			await deleteUnreferencedRawMail(env, db, payload.rawR2Key);
			console.warn(`Mailing list ${list.localPart}@${list.hostname}: held post retained at ${heldKey} — no reviewer could receive it`);
			return;
		}
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
