import { dialectOf } from "@/db/introspect";
import type { DatabaseDialect } from "@/db/dialect";

/**
 * The name the attachment-text index goes by on each dialect (F52/F53): the FTS5 table
 * on SQLite, the partial GIN expression index on PostgreSQL, the FULLTEXT index on
 * MySQL. conditions.ts answers attachment matches through whichever one exists.
 *
 * The SQL search runs against `search_text` (the normalized stream, F53 r2), so on
 * PostgreSQL and MySQL "exists" means the index *on that column* — not just the name.
 * A database can legitimately sit at the r1 migration, where the same index name
 * covers raw `extracted_text`: probing the name alone would then report true and the
 * search would fail on a missing column instead of degrading. On SQLite this does not
 * arise — the FTS5 table reads its source view, and the pre-r2 view on `extracted_text`
 * still answers normalized queries correctly (unicode61 folds accents and splits
 * punctuation the same way), so the table's existence stays the right probe there.
 */
const INDEX_OBJECT: Record<DatabaseDialect, string> = {
	sqlite: "attachments_fts",
	postgres: "message_attachments_extracted_text_fts_idx",
	mysql: "message_attachments_extracted_text_fts_idx",
};

/**
 * Whether the attachment-text index (F52, `attachments_fts`) exists — as seen by the
 * connection that is about to run the search.
 *
 * Deployment applies the application first and the migrations afterwards, from Admin
 * (docs/deployment.md). A SQLite database can therefore be one release behind the code
 * that is serving it, and a query that names a table the migration has not created does
 * not fail partially: SQLite cannot prepare it, so every free-text search — message-only
 * ones included — would answer 500 with `no such table: attachments_fts`. Search asks this
 * module first and falls back to the pre-F52 message-only predicates when the answer is
 * no (see `SearchConditionOptions` in ./conditions).
 *
 * The answer is cached per **connection**, never per database binding, because on D1 a
 * connection is a read session and sessions have independent schema visibility: with read
 * replication `env.DB` is the request's `withSession` handle (`worker.ts` →
 * `withD1ReadSession` → `withD1Session`), anchored at the client's bookmark or at
 * `first-unconstrained`, and a replica may not have applied 0109 yet. A positive probed on
 * an up-to-date session says nothing about the next session's replica — reusing it there
 * emitted `attachments_fts` SQL the replica could not prepare, which was an HTTP 500 on
 * positive, negative and mixed searches (F52 gate round 2). Probing the same connection the
 * search then runs on removes that skew by construction; D1 guarantees a session's reads
 * are at least as current as its own bookmark, so the answer stays true for that connection.
 *
 * What that costs:
 *   - With read replication on, the key is the request's session, so this is one
 *     `sqlite_master` lookup per free-text search request (cached within the request, so
 *     building conditions twice does not probe twice). One indexed catalog read next to
 *     the queries a search already runs.
 *   - Without a session (`env.DB` is the raw binding: queue and cron consumers, the
 *     self-hosted server, requests that must read the primary) the key is that binding and
 *     the answer is reused for the isolate's life, so those paths pay it once.
 *   - A "no" is cached for `MISS_TTL_MS` on the same connection only, so a session that
 *     sees stale schema is never mistaken for the database's state; "Update database"
 *     applies the migration on the primary and `applyPendingMigrations` clears the cache
 *     outright, so the next probe sees the index without a redeploy.
 *
 * PostgreSQL and MySQL have no D1 session problem — their `env.DB` is one external
 * connection per process, and WeakMap keyed on it is the right granularity. Their
 * probe is one catalog lookup (`to_regclass` / `information_schema.statistics`)
 * against the migration-created index (0041), bounded the same way: cached per
 * connection, a "no" re-asked after MISS_TTL_MS, cleared when migrations apply.
 */
const MISS_TTL_MS = 30_000;

type Probe = { available: boolean; checkedAt: number };

/** Keyed by connection (`env.DB`), not by `DB_PRIMARY`: see the module comment. */
let probes = new WeakMap<object, Probe>();
/** Bumped by every clear, so a probe already in flight cannot publish an answer past the reset. */
let generation = 0;

/** The bindings the probe reads; a full `CloudflareEnv`, or just `{ DB }` in tests and scripts. */
type ProbeEnv = Pick<CloudflareEnv, "DB">;

/** Forget the cached answers — every connection (the migration path), or just one (tests). */
export function clearAttachmentIndexProbe(connection?: object): void {
	generation += 1;
	if (!connection) {
		probes = new WeakMap();
		return;
	}
	probes.delete(connection);
}

/**
 * The catalog lookup for the dialect's index object; each is one row off the catalog.
 * PostgreSQL's reports the index definition so the caller can tell an index on
 * `search_text` (r2) from one on raw `extracted_text` (r1); MySQL's counts the
 * FULLTEXT index entry on the `search_text` column specifically — between the
 * add-column and create-index migrations the name alone would lie.
 */
function probeSql(dialect: DatabaseDialect): string {
	if (dialect === "postgres") {
		return `SELECT CASE WHEN to_regclass('${INDEX_OBJECT.postgres}') IS NULL THEN NULL ELSE pg_get_indexdef(to_regclass('${INDEX_OBJECT.postgres}')) END AS def`;
	}
	if (dialect === "mysql") {
		return `SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'message_attachments' AND index_name = '${INDEX_OBJECT.mysql}' AND column_name = 'search_text' AND index_type = 'FULLTEXT'`;
	}
	return "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments_fts'";
}

export async function hasAttachmentSearchIndex(env: ProbeEnv): Promise<boolean> {
	const connection = env.DB;
	const dialect = dialectOf(connection);
	const cached = probes.get(connection);
	if (cached && (cached.available || Date.now() - cached.checkedAt < MISS_TTL_MS)) return cached.available;
	// Capture the cache identity before awaiting: a clear can replace the map (or empty this
	// entry) while the probe is in flight, and publishing this answer afterwards would
	// restamp state that was just reset.
	const map = probes;
	const startedAt = generation;
	const found = await connection.prepare(probeSql(dialect)).first<{ name?: string | null; def?: string | null; n?: number }>();
	const available =
		dialect === "mysql" ? Number(found?.n ?? 0) > 0 : dialect === "postgres" ? !!found?.def?.includes("search_text") : !!found?.name;
	if (map === probes && startedAt === generation) map.set(connection, { available, checkedAt: Date.now() });
	return available;
}
