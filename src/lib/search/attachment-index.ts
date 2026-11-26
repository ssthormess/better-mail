import { dialectOf } from "@/db/introspect";

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
 * PostgreSQL and MySQL have no attachment index (F53 adds their parity), so the answer
 * there is always false.
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

export async function hasAttachmentSearchIndex(env: ProbeEnv): Promise<boolean> {
	const connection = env.DB;
	if (dialectOf(connection) !== "sqlite") return false;
	const cached = probes.get(connection);
	if (cached && (cached.available || Date.now() - cached.checkedAt < MISS_TTL_MS)) return cached.available;
	// Capture the cache identity before awaiting: a clear can replace the map (or empty this
	// entry) while the probe is in flight, and publishing this answer afterwards would
	// restamp state that was just reset.
	const map = probes;
	const startedAt = generation;
	const found = await connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments_fts'").first<{ name: string }>();
	const available = !!found?.name;
	if (map === probes && startedAt === generation) map.set(connection, { available, checkedAt: Date.now() });
	return available;
}
