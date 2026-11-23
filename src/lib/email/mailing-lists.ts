import { eq } from "drizzle-orm";
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
 */
export async function expandMailingListDeliveries(
	db: AppDatabase,
	list: ResolvedList,
	envelopeFrom?: string | null,
): Promise<MailingListExpansion> {
	const deliveries = new Map<string, MailingListDelivery>();
	const skipped: SkippedListMember[] = [];
	await collectMemberDeliveries(db, list.listId, envelopeFrom, deliveries, skipped, new Set([list.listId]), 0);

	// Sender dedup: a member posting to the list does not get a copy of their
	// own post, whether their member row uses the address they sent from or an
	// alias of the same mailbox.
	const sender = await resolveInboundAddress(db, envelopeFrom ?? "");
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
): Promise<void> {
	const members = await db
		.select({ email: mailingListMembers.email })
		.from(mailingListMembers)
		.where(eq(mailingListMembers.listId, listId));

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
			await collectMemberDeliveries(db, decision.list.listId, envelopeFrom, deliveries, skipped, visitedListIds, depth + 1);
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
 * External members (an address no hosted domain resolves) are skipped, not
 * forwarded: the outbound queue only sends from user-owned mailbox identities,
 * and correct off-instance list forwarding (envelope sender rewriting, posting
 * rules) belongs to a later slice.
 *
 * A member failure does not lose the sibling deliveries: every member is
 * attempted, then the first error is rethrown so the queue retry replays the
 * payload — already-stored members are skipped by the storage-key dedup.
 */
export async function deliverToMailingList(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	list: ResolvedList,
	deliver: (payload: InboundQueueMessage, mailbox: ResolvedMailbox) => Promise<void>,
): Promise<void> {
	const db = getDb(env);
	const { deliveries, skipped } = await expandMailingListDeliveries(db, list, payload.from);
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
