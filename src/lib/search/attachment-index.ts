import { dialectOf } from "@/db/introspect";

/**
 * Whether the attachment-text index (F52, `attachments_fts`) exists yet.
 *
 * Deployment applies the application first and the migrations afterwards, from Admin
 * (docs/deployment.md). A SQLite database can therefore be one release behind the code
 * that is serving it, and a query that names a table the migration has not created does
 * not fail partially: SQLite cannot prepare it, so every free-text search — message-only
 * ones included — would answer 500 with `no such table: attachments_fts`. Search asks this
 * module first and falls back to the pre-F52 message-only predicates until the index
 * exists (see `SearchConditionOptions` in ./conditions).
 *
 * Cost: one `sqlite_master` lookup per isolate, not one per query.
 *   - A hit is cached for the life of the isolate: a table that exists is not dropped
 *     by a later migration, so there is nothing to re-check.
 *   - A miss is cached for `MISS_TTL_MS` only. "Update database" can apply 0109 while
 *     this isolate keeps serving, and the database must become searchable without a
 *     redeploy; the applied-migration path also clears the entry outright
 *     (`applyPendingMigrations`), so the TTL only covers a migration applied by another
 *     means (Wrangler, another isolate, a restored backup).
 *   - The entry is keyed by the database binding, not by `env.DB`: with D1 read
 *     replication `env.DB` is the request's session, a new object per request, so keying
 *     on it would probe on every search. `DB_PRIMARY` is the raw binding the session was
 *     opened from (see withD1Session) and is stable for the isolate's lifetime.
 *
 * PostgreSQL and MySQL have no attachment index (F53 adds their parity), so the answer
 * there is always false.
 */
const MISS_TTL_MS = 30_000;

type Probe = { available: boolean; checkedAt: number };
let probes = new WeakMap<object, Probe>();

/** The bindings the probe reads; a full `CloudflareEnv`, or just `{ DB }` in tests and scripts. */
type ProbeEnv = Pick<CloudflareEnv, "DB"> & Partial<Pick<CloudflareEnv, "DB_PRIMARY">>;

/** Forget the cached answer — every database (the migration path), or just one (tests). */
export function clearAttachmentIndexProbe(db?: object): void {
	if (!db) {
		probes = new WeakMap();
		return;
	}
	probes.delete(db);
}

export async function hasAttachmentSearchIndex(env: ProbeEnv): Promise<boolean> {
	const db = env.DB;
	if (dialectOf(db) !== "sqlite") return false;
	const cacheKey: object = env.DB_PRIMARY ?? db;
	const cached = probes.get(cacheKey);
	if (cached && (cached.available || Date.now() - cached.checkedAt < MISS_TTL_MS)) return cached.available;
	const found = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments_fts'").first<{ name: string }>();
	const available = !!found?.name;
	probes.set(cacheKey, { available, checkedAt: Date.now() });
	return available;
}
