import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { dialectOf } from "@/db/introspect";
import { messageAttachments } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { normalizeSearchText } from "./normalize";

/**
 * Maintenance for the full-text indexes. On SQLite (D1) triggers keep both FTS5 tables current, so a rebuild is
 * only needed after a restore from a backup that predates an index, or if the counts below ever disagree.
 * PostgreSQL and MySQL search the message columns directly (see conditions.ts) and their attachment indexes
 * (F53) are engine-maintained — a GIN or FULLTEXT index is written with the row, so unlike an external-content
 * FTS5 table it cannot drift and there is nothing to rebuild. The status therefore still reports every message
 * as searchable on those dialects.
 */

/**
 * Rows per `backfillAttachmentSearchText` call. The sweep calls it once a run
 * (a steady drain next to the extraction batch) and the admin rebuild loops it,
 * so the bound only has to keep a single call cheap — 200 normalizations is a
 * few milliseconds of regex work.
 */
export const ATTACHMENT_SEARCH_BACKFILL_BATCH = 200;

/**
 * Write `search_text` for attachments that have extracted text but no
 * normalized stream yet: rows written before the column existed (F53 r2), or
 * restored from a backup whose `search_text` did not reach the target. This is
 * the only way a row becomes visible to attachment search besides the
 * extraction write itself, because no engine can compute the stream — accent
 * folding is not expressible in portable SQL, which is also why there are no
 * triggers for it on any dialect.
 *
 * Bounded and idempotent: each pass fills at most `limit` rows, oldest first,
 * and the conditional `search_text IS NULL` lets a concurrent writer win.
 * A database that has not applied the column's migration answers 0 (the
 * missing column is one more version behind, like the index probe).
 */
export async function backfillAttachmentSearchText(db: ReturnType<typeof getDb>, limit = ATTACHMENT_SEARCH_BACKFILL_BATCH): Promise<number> {
	try {
		const rows = await db
			.select({ id: messageAttachments.id, extractedText: messageAttachments.extractedText })
			.from(messageAttachments)
			.where(
				and(
					eq(messageAttachments.extractStatus, "done"),
					isNotNull(messageAttachments.extractedText),
					isNull(messageAttachments.searchText),
				),
			)
			.orderBy(asc(messageAttachments.createdAt))
			.limit(limit);
		for (const row of rows) {
			// An empty stream is stored as "", never NULL — NULL is "not normalized yet"
			// and would re-enter this batch every run.
			await db
				.update(messageAttachments)
				.set({ searchText: normalizeSearchText(row.extractedText) })
				.where(and(eq(messageAttachments.id, row.id), isNull(messageAttachments.searchText)));
		}
		return rows.length;
	} catch (error) {
		if (isMissingColumnError(error) || isMissingTableError(error)) return 0;
		throw error;
	}
}

/** The rebuild loops the backfill until it runs dry or this many batches ran (10k rows per call). */
const BACKFILL_REBUILD_BATCHES = 50;

export async function rebuildSearchIndex(env: CloudflareEnv): Promise<void> {
	const db = getDb(env);
	// Normalization is app-side, so engine indexes cannot fill `search_text` themselves:
	// drain the backlog first on every dialect, or the indexes that follow would rebuild
	// over rows that have no token stream yet. Bounded per invocation; the sweep's
	// per-run pass converges whatever is left.
	for (let i = 0; i < BACKFILL_REBUILD_BATCHES; i += 1) {
		if ((await backfillAttachmentSearchText(db)) < ATTACHMENT_SEARCH_BACKFILL_BATCH) break;
	}
	if (dialectOf(env.DB) !== "sqlite") return;
	await env.DB.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')").run();
	// `attachments_fts` (attachment text, F52) is rebuilt separately and tolerates a database that has not
	// applied its migration yet, so a rebuild request still repairs the message index on such a database.
	// Its external content is the `attachments_fts_source` view (only rows with `extract_status = 'done'` and
	// a normalized `search_text`), so a rebuild re-creates exactly the postings the triggers maintain — it
	// cannot revive text that is not eligible any more, and it clears orphan postings left by an older index shape.
	try {
		await env.DB.prepare("INSERT INTO attachments_fts(attachments_fts) VALUES ('rebuild')").run();
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}
}

export async function getSearchIndexStatus(env: CloudflareEnv): Promise<{ indexed: number; messages: number }> {
	if (dialectOf(env.DB) !== "sqlite") {
		const total = await env.DB.prepare("SELECT count(*) AS n FROM messages").first<{ n: number }>();
		const messages = Number(total?.n ?? 0);
		return { indexed: messages, messages };
	}
	const [indexed, total] = await env.DB.batch<{ n: number }>([
		env.DB.prepare("SELECT count(*) AS n FROM messages_fts"),
		env.DB.prepare("SELECT count(*) AS n FROM messages"),
	]);
	return { indexed: indexed.results[0]?.n ?? 0, messages: total.results[0]?.n ?? 0 };
}
