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
