import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ids";

export async function inboundMessageId(rawR2Key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawR2Key));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `msg_${hex}`;
}

async function sha256Hex(parts: (string | Uint8Array)[]): Promise<string> {
	const encoder = new TextEncoder();
	const buffers = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
	const joined = new Uint8Array(buffers.reduce((total, buffer) => total + buffer.length, 0));
	let offset = 0;
	for (const buffer of buffers) {
		joined.set(buffer, offset);
		offset += buffer.length;
	}
	const digest = await crypto.subtle.digest("SHA-256", joined);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every queued inbound event stages its raw bytes under this prefix. */
export const INBOUND_STAGING_PREFIX = "inbound/staging/";

/**
 * Deterministic storage key for an inbound message, derived from the scope and
 * the raw bytes. The scope names the stored object's owner — a mailbox for
 * member copies and direct deliveries — and is type-prefixed
 * (`mailbox:<id>`) so scopes of different kinds can never collide on one key;
 * before the prefix existed a list id and a mailbox id shared the namespace.
 *
 * A canonical key is shared by construction: every delivery of identical bytes
 * to the same destination computes it. That is the intended contract — a relay
 * retry, a second RCPT of the same message, and a member reached directly and
 * through a list are the *same* message to that mailbox and collapse to one
 * stored copy on `(mailboxId, rawR2Key)`. It also means no event may delete a
 * canonical object it did not store a message row for: another event or a
 * stored message can reference it, which is why queue events stage bytes under
 * `INBOUND_STAGING_PREFIX` instead and deletes check `messages.rawR2Key`.
 *
 * Sender-controlled headers such as `Message-ID` are deliberately not part of
 * the key: a third party who knows a message's `Message-ID` could otherwise
 * overwrite its stored raw MIME or make the real delivery look like a
 * duplicate.
 */
export async function inboundStorageKey(raw: ArrayBuffer, scope?: string): Promise<string> {
	return `inbound/${await sha256Hex([scope ?? "", "\0", new Uint8Array(raw)])}.eml`;
}

/** The canonical scope a stored message copy belongs to: its mailbox. */
export function mailboxInboundScope(mailboxId: string): string {
	return `mailbox:${mailboxId}`;
}

/**
 * A per-event object key for raw bytes in flight between the receiving handler
 * and the queue consumer. Staging objects are private to one delivery event —
 * only that event's consumer ever deletes them — which is what keeps a
 * reject/no-route cleanup from deleting an object a sibling delivery or a
 * stored message references. Orphans (a consumer that died before cleanup)
 * expire with the 24h `sweepOrphanedRawMail` run.
 */
export function inboundStagingKey(): string {
	return `${INBOUND_STAGING_PREFIX}${newId("stg")}.eml`;
}

/**
 * A held-for-moderation post with no deliverable reviewer is retained under
 * `held/`, keyed by list and content hash so queue retries stay idempotent.
 * The `held/` prefix sits outside the `inbound/` orphan sweep on purpose:
 * these objects are the retention, and a later moderation slice owns their
 * lifecycle.
 */
export async function heldInboundKey(listId: string, raw: ArrayBuffer): Promise<string> {
	return `held/${listId}/${await sha256Hex([new Uint8Array(raw)])}.eml`;
}

/**
 * Deletes a raw inbound object only when no stored message references it.
 * Canonical keys are shared between deliveries of identical bytes, so the one
 * rule every cleanup path follows is: never delete an object a message row
 * owns. Per-event staging objects are never referenced and always pass; a
 * reject/no-route decision for one event can therefore never clobber the
 * object a sibling delivery or an already-stored message still needs.
 */
export async function deleteUnreferencedRawMail(
	env: CloudflareEnv,
	db: AppDatabase,
	key: string,
): Promise<void> {
	const [row] = await db.select({ id: messages.id }).from(messages).where(eq(messages.rawR2Key, key)).limit(1);
	if (row) return;
	await env.BUCKET.delete(key).catch((error) => console.error(`Raw cleanup failed for ${key}`, error));
}
