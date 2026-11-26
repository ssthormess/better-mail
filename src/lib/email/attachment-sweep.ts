import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { getAttachmentText } from "@/lib/email/attachment-text";

/**
 * The enrichment job for attachment text (F52). Nothing parses a PDF on a request
 * path, so a row that arrives at `extract_status = 'none'` — every PDF, and every
 * attachment stored before extraction existed — needs a bounded context to reach
 * "done". This sweep is that context and the only enricher: it is a five-minute
 * entry of the shared job registry (src/lib/scheduled/jobs.ts), which the Worker
 * cron, the Vercel cron routes and the self-hosted loop all run.
 *
 * One run takes a fixed batch of the oldest pending rows and extracts them one at
 * a time. Sequential awaits bound the work per run twice over: the batch size caps
 * how many files are parsed, and each `getAttachmentText` call caps what it reads
 * (MAX_EXTRACTION_SOURCE_BYTES, a ranged read, MAX_EXTRACTION_PDF_PAGES). A file
 * that cannot be parsed is recorded as failed and the sweep moves on; a bucket or
 * database error on one row never stops the batch.
 *
 * A row stays invisible to attachment search until a run reaches it: search only
 * matches `attachments_fts`, which the triggers fill when a row becomes "done".
 * That is why the batch size is deliberately small — it is a steady drain, not a
 * way to catch up quickly.
 *
 * Trashed rows are extracted like any other: it costs one parse, and an attachment
 * restored from the Drive trash then already has its text (the purge removes the
 * rest).
 */

/**
 * Rows per run. One run per 5 minutes drains 1,440 attachments a day, and a run's
 * worst case is this many 5 MB PDFs parsed back to back — a batch any single
 * scheduled invocation can finish.
 */
export const ATTACHMENT_EXTRACTION_SWEEP_BATCH = 5;

export type AttachmentSweepResult = {
	/** Rows this run picked up. */
	scanned: number;
	/** Rows that ended at "done" (text found or the file holds none). */
	done: number;
	/** Rows the parser rejected. */
	failed: number;
	/** Rows whose type or size is not worth extracting. */
	skipped: number;
	/** Rows still at "none" when the run finished, including any it could not touch. */
	pending: number;
};

/**
 * Enrich the oldest pending attachments, then report what happened. Never throws
 * for a single attachment: a failure is that row's status. A database error while
 * reading the batch is the caller's to handle (the scheduler logs it and retries on
 * the next tick).
 */
export async function sweepAttachmentExtraction(
	env: CloudflareEnv,
	options: { limit?: number } = {},
): Promise<AttachmentSweepResult> {
	const db = getDb(env);
	const limit = options.limit ?? ATTACHMENT_EXTRACTION_SWEEP_BATCH;
	const result: AttachmentSweepResult = { scanned: 0, done: 0, failed: 0, skipped: 0, pending: 0 };

	// Oldest first, which `message_attachments_extract_status_idx` serves in index
	// order: the status filter and the sort are both satisfied by the same scan, so
	// the batch is a seek rather than a table sort. Rows sharing a second come back
	// in no particular order, which costs nothing — each run decides whichever it
	// picked, and the next run reads the rest.
	const pending = await db
		.select({ id: messageAttachments.id })
		.from(messageAttachments)
		.where(eq(messageAttachments.extractStatus, "none"))
		.orderBy(asc(messageAttachments.createdAt))
		.limit(limit);

	for (const row of pending) {
		result.scanned += 1;
		try {
			const extracted = await getAttachmentText(env, row.id);
			// A row deleted between the batch read and now has no outcome to count.
			if (!extracted) continue;
			if (extracted.status === "done") result.done += 1;
			else if (extracted.status === "failed") result.failed += 1;
			else result.skipped += 1;
		} catch (error) {
			// A read or write that failed leaves the row at "none" for a later run.
			result.failed += 1;
			console.error(`Attachment extraction sweep failed for ${row.id}`, error);
		}
	}

	const [remaining] = await db
		.select({ count: sql<number>`count(*)` })
		.from(messageAttachments)
		.where(eq(messageAttachments.extractStatus, "none"));
	result.pending = Number(remaining?.count ?? 0);
	return result;
}
