import type { AppDatabase } from "@/db";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getMailboxUsage } from "@/lib/mailboxes/usage";

/** Send refused because the mailbox is over its storage cap; surfaces as HTTP 413. */
export class MailboxStorageQuotaError extends Error {
	readonly code = "MAILBOX_STORAGE_QUOTA_EXCEEDED";

	constructor(usedBytes: number, outgoingBytes: number, limitBytes: number) {
		super(`Mailbox storage quota exceeded: ${usedBytes + outgoingBytes} bytes used, the limit is ${limitBytes} bytes`);
		this.name = "MailboxStorageQuotaError";
	}
}

/**
 * Global per-mailbox storage cap in bytes from MAILBOX_STORAGE_LIMIT_BYTES (wrangler
 * vars / process env). Unset, unreadable or non-positive means unlimited — the same
 * null semantics as `getDriveStorageLimit`. A per-mailbox limit column and the raw
 * MIME bytes it should count are schema work left to a later quota slice.
 */
export function getMailboxStorageLimit(env: CloudflareEnv): number | null {
	const value = Number(env.MAILBOX_STORAGE_LIMIT_BYTES);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * What a send adds to mailbox usage: the stored text/html bodies at their UTF-8 octet
 * length plus each attachment's content bytes — the same accounting basis as
 * `getMailboxUsage`, so the check and the eventual rows agree. Raw MIME blobs stay
 * excluded on both sides; a provider rewriting bodies at delivery is ignored.
 */
export function estimateOutgoingBytes(input: { text?: string | null; html?: string | null; attachments?: AttachmentContent[] }): number {
	const encoder = new TextEncoder();
	let bytes = 0;
	if (input.text) bytes += encoder.encode(input.text).byteLength;
	if (input.html) bytes += encoder.encode(input.html).byteLength;
	for (const attachment of input.attachments ?? []) bytes += attachment.content.byteLength;
	return bytes;
}

/**
 * Rejects a send that would push the mailbox over MAILBOX_STORAGE_LIMIT_BYTES.
 * Runs before any row or object is written, so a refused send leaves nothing behind.
 * A draft may still exist over the cap — it just cannot be sent.
 */
export async function checkMailboxQuota(env: CloudflareEnv, db: AppDatabase, mailboxId: string, outgoingBytes: number): Promise<void> {
	const limit = getMailboxStorageLimit(env);
	if (limit === null) return;
	const usage = await getMailboxUsage(db, mailboxId);
	if (usage.totalBytes + outgoingBytes > limit) {
		throw new MailboxStorageQuotaError(usage.totalBytes, outgoingBytes, limit);
	}
}

/** Bounce reason shared by every inbound surface: the Worker's setReject, the SMTP listener's 550 and the relay route's reject response all show it to the sender, and the post-queue drop logs it. */
export const INBOUND_QUOTA_REJECT_REASON = "Message rejected: the recipient mailbox is over its storage limit.";

/**
 * What a stored inbound message adds to mailbox usage — the same accounting
 * basis as `estimateOutgoingBytes` and `getMailboxUsage`: the (already bounded)
 * text/html bodies at UTF-8 octet length plus attachment content bytes. Called
 * after MIME parsing, because raw size and stored size diverge in both
 * directions: MIME headers and transfer encodings inflate the raw blob, while
 * an 8-bit or ISO-8859 body can decode to *more* UTF-8 octets than the raw size.
 */
export function estimateInboundStoredBytes(parsed: { text?: string | null; html?: string | null; attachments?: AttachmentContent[] }): number {
	return estimateOutgoingBytes(parsed);
}

/**
 * True when storing `incomingBytes` more would put the mailbox over
 * MAILBOX_STORAGE_LIMIT_BYTES. Same boundary as `checkMailboxQuota`: landing
 * exactly on the limit is allowed, and an unset or unreadable limit is unlimited.
 *
 * `incomingBytes` is whichever basis the call site can see: raw MIME size at the
 * pre-queue gates (a best-effort estimate only — see `estimateInboundStoredBytes`)
 * and the real parsed size in the queue consumer, which is the decisive check.
 * Raw blobs stay out of `getMailboxUsage` either way (its documented gap).
 *
 * No owner notice is emitted on a reject or drop: the realtime union only carries
 * new-message and agent-draft payloads, so there is no generic notice type to
 * send without client work — and a wired one would fire an unthrottled push per
 * dropped message. The SMTP bounce is the sender's notice where a bounce exists;
 * the owner sees the usage card.
 */
export async function mailboxInboundQuotaExceeded(env: CloudflareEnv, db: AppDatabase, mailboxId: string, incomingBytes: number): Promise<boolean> {
	const limit = getMailboxStorageLimit(env);
	if (limit === null) return false;
	const usage = await getMailboxUsage(db, mailboxId);
	return usage.totalBytes + incomingBytes > limit;
}
