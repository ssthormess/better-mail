import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { getAttachmentText } from "@/lib/email/attachment-text";
import { backfillAttachmentSearchText } from "@/lib/search/index-admin";

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
	/** Rows this run picked up. A row deleted before the run reached it has no outcome to count. */
	scanned: number;
	/** Rows that ended at "done" with the outcome confirmed stored (text found or the file holds none). */
	done: number;
	/** Rows the parser rejected, confirmed stored. */
	failed: number;
	/** Rows whose type or size is not worth extracting, confirmed stored. */
	skipped: number;
	/**
	 * Rows still at "none" because this run could not confirm an outcome — the read or the
	 * write threw. They hold no decision, so they are not reported as done/failed/skipped
	 * and a later run reads them again.
	 */
	undecided: number;
	/**
	 * Whether the batch was full, i.e. more rows are waiting. A bounded signal: it costs one
	 * extra index entry on the same seek, never a count(*) over the whole backlog.
	 */
	morePending: boolean;
	/**
	 * Rows this run filled `search_text` for (F53 r2). Extraction writes the normalized
	 * stream with the text, but rows extracted before the column existed — or restored
	 * without it — keep a NULL sidecar until this drain reaches them, invisible to
	 * attachment search exactly like a pending row is until extraction reaches it.
	 */
	normalized: number;
};

/**
 * Enrich the oldest pending attachments, then report what happened. Never throws
 * for a single attachment: a failure is that row's status. A database error while
 * reading the batch is the caller's to handle (the scheduler logs it and retries on
 * the next tick).
 *
 * Bounded work, on purpose: the batch reads `limit` candidates plus one, so the cost per
 * run does not grow with the backlog. Neither scheduler uses the result, so there is no
 * exact pending count — a count(*) over 100,000 pending rows stepped through the whole
 * covering index on every tick (F52 gate).
 *
 * A row whose outcome cannot be persisted stays "none" and keeps its old `created_at`, so
 * it is the oldest again on the next tick: that is the retry. It also means a handful of
 * rows that permanently kill the parser (a runtime timeout that cannot be caught, see
 * attachment-text.ts) would occupy the batch for every later run. Accepted for now — the
 * alternative is a retry column and a migration for it, and extraction progress is
 * enrichment, not delivery. A row that parses but fails in the database is the same case.
 */
export async function sweepAttachmentExtraction(
	env: CloudflareEnv,
	options: { limit?: number } = {},
): Promise<AttachmentSweepResult> {
	const db = getDb(env);
	const limit = options.limit ?? ATTACHMENT_EXTRACTION_SWEEP_BATCH;
	const result: AttachmentSweepResult = { scanned: 0, done: 0, failed: 0, skipped: 0, undecided: 0, morePending: false, normalized: 0 };

	// Oldest first, which `message_attachments_extract_status_idx` serves in index
	// order: the status filter and the sort are both satisfied by the same scan, so
	// the batch is a seek rather than a table sort. Rows sharing a second come back
	// in no particular order, which costs nothing — each run decides whichever it
	// picked, and the next run reads the rest. One row past the batch answers
	// "is there more to do?" without counting the backlog.
	const candidates = await db
		.select({ id: messageAttachments.id })
		.from(messageAttachments)
		.where(eq(messageAttachments.extractStatus, "none"))
		.orderBy(asc(messageAttachments.createdAt))
		.limit(limit + 1);
	result.morePending = candidates.length > limit;

	for (const row of candidates.slice(0, limit)) {
		result.scanned += 1;
		try {
			const extracted = await getAttachmentText(env, row.id);
			// A row deleted between the batch read and now has no outcome to count.
			if (!extracted) continue;
			if (!extracted.persisted) {
				// The parse happened but the row still says "none"; reporting its status
				// would claim a decision the next run has to make again.
				result.undecided += 1;
				continue;
			}
			if (extracted.status === "done") result.done += 1;
			else if (extracted.status === "failed") result.failed += 1;
			else result.skipped += 1;
		} catch (error) {
			// A read or write that failed leaves the row at "none" for a later run.
			result.undecided += 1;
			console.error(`Attachment extraction sweep failed for ${row.id}`, error);
		}
	}

	// The second drain: rows with extracted text but no normalized `search_text` —
	// written before the column existed or restored without it. No engine can fill
	// it (accent folding is not portable SQL), so this run does it app-side, one
	// bounded batch per tick; on a database that has not applied the column's
	// migration the call is a cheap no-op.
	result.normalized = await backfillAttachmentSearchText(db);

	return result;
}
