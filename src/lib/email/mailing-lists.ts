import { and, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { mailingListMembers } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { inboundStorageKey } from "@/lib/email/inbound-id";
import { resolveInboundAddress, type ResolvedList, type ResolvedMailbox } from "@/lib/email/routing";
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
	// alias of the same mailbox.
	const sender = await resolveInboundAddress(db, envelopeFrom ?? "", null, { skipPostingAuth: true });
	if (sender?.mailbox) deliveries.delete(sender.mailbox.mailboxId);

	return { deliveries: [...deliveries.values()], skipped };
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
 * owner copy is the moderation notice: approving means reposting or forwarding
 * to the list as an owner. A real pending-posts queue with approve/discard is
 * a later slice.
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
		console.warn(`Mailing list ${list.localPart}@${list.hostname} has no deliverable members`);
		await env.BUCKET.delete(payload.rawR2Key).catch((error) => console.error(`Raw cleanup failed for ${payload.rawR2Key}`, error));
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
		const rawR2Key = await inboundStorageKey(buffer, delivery.mailbox.mailboxId);
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
	await env.BUCKET.delete(payload.rawR2Key).catch((error) => console.error(`Raw cleanup failed for ${payload.rawR2Key}`, error));
}
