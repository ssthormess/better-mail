import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { isExternalDatabase } from "@/db/external";
import { calendarEventOverrides, calendarEvents, calendarSubscriptions, users } from "@/db/schema";
import { isMissingColumnError, isMissingTableError, isUniqueConstraintError } from "@/lib/database-errors";
import { hasPublicEgressGuarantee } from "@/lib/runtime";
import { normalizeTimeZone } from "@/lib/time/utils";
import { chunkIds } from "./chunks";
import { prepareCalendarImport, type ImportIdScheme, type ImportEventRow, type ImportOverrideRow, type PreparedCalendarImport } from "./ics-import";
import { fetchCalendarFeed, FeedFetchError, type FeedFetchOptions } from "./subscription-feed";

/** The cron ticks every five minutes, so a shorter interval could never be honored. */
export const MIN_REFRESH_INTERVAL_SEC = 300;
/** A month between pulls is long enough for even the quietest feed. */
export const MAX_REFRESH_INTERVAL_SEC = 30 * 24 * 3600;
export const DEFAULT_REFRESH_INTERVAL_SEC = 3600;

/** Subscriptions read per query; the run pages through all of them by id. */
const SUBSCRIPTION_PAGE = 200;
/** Pages read per run, so one tick stays bounded (50,000 feeds); hitting it is logged. */
const MAX_SUBSCRIPTION_PAGES = 25;

/**
 * Feed-owned event identity: evt_s_<sha256(userId|subId|uid)>. The evt_s_ namespace keeps these
 * rows disjoint from user events (evt_), invitations (inv_) and file imports (evt_i_), so a
 * refresh can update and prune exactly the rows this feed created and no others. Two feeds — or a
 * feed and a file import — carrying the same UID therefore coexist as visible duplicates; merging
 * them is a later UX decision.
 */
export function subscriptionIdScheme(userId: string, subscriptionId: string): ImportIdScheme {
	return {
		prefix: "evt_s",
		seedMaterial: (seed) => `${userId}|${subscriptionId}|${seed}`,
		fieldsMaterial: (material) => `${userId}|${subscriptionId}|fields:${material}`,
		overrideMaterial: (eventId, occurrenceMs) => `${userId}|${subscriptionId}|${eventId}|${occurrenceMs}`,
	};
}

export function normalizeRefreshIntervalSec(value: unknown): number | null {
	if (value === undefined || value === null) return DEFAULT_REFRESH_INTERVAL_SEC;
	const interval = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(interval) || interval < MIN_REFRESH_INTERVAL_SEC || interval > MAX_REFRESH_INTERVAL_SEC) return null;
	return interval;
}

export function subscriptionDue(subscription: { lastRefreshAt: Date | null; refreshIntervalSec: number }, now: Date): boolean {
	return subscription.lastRefreshAt === null || subscription.lastRefreshAt.getTime() + subscription.refreshIntervalSec * 1000 <= now.getTime();
}

/** The event columns a refresh owns — identity (id/userId), mailbox linkage, invite state and subscriptionId are never touched. */
const MASTER_COLUMNS = ["title", "description", "location", "attendees", "color", "repeat", "repeatDays", "repeatAnchorDay", "repeatUntil", "repeatInterval", "repeatWeekday", "repeatWeek", "excludedOccurrences", "timeZone", "startsAt", "endsAt", "reminderMinutes"] as const;

function masterFields(event: ImportEventRow): Partial<typeof calendarEvents.$inferInsert> {
	return Object.fromEntries(MASTER_COLUMNS.map((column) => [column, event[column]])) as Partial<typeof calendarEvents.$inferInsert>;
}

const instant = (value: unknown): number | null => (value instanceof Date ? value.getTime() : null);

function masterDiffers(existing: typeof calendarEvents.$inferSelect, event: ImportEventRow): boolean {
	return MASTER_COLUMNS.some((column) => {
		const a = existing[column];
		const b = event[column];
		return a instanceof Date || b instanceof Date ? instant(a) !== instant(b) : a !== b;
	});
}

const OVERRIDE_COLUMNS = ["startsAt", "endsAt", "title", "description", "location"] as const;

function overrideDiffers(existing: typeof calendarEventOverrides.$inferSelect, override: ImportOverrideRow): boolean {
	return OVERRIDE_COLUMNS.some((column) => {
		const a = existing[column];
		const b = override[column];
		return a instanceof Date || b instanceof Date ? instant(a) !== instant(b) : a !== b;
	});
}

/**
 * Affected-row count for one write, over the shapes our drivers return: D1/better-sqlite3 give
 * `meta.changes`, mysql-proxy a top-level `affectedRows`, pg-proxy rows[0].affectedRows. A result
 * whose shape none of them match reports null — unknown, not zero.
 */
function rowsAffected(result: unknown): number | null {
	const shaped = result as { meta?: { changes?: unknown }; affectedRows?: unknown; rows?: { affectedRows?: unknown }[] } | null;
	if (typeof shaped?.meta?.changes === "number") return shaped.meta.changes;
	if (typeof shaped?.affectedRows === "number") return shaped.affectedRows;
	const first = (Array.isArray(result) ? result[0] : shaped?.rows?.[0]) as { affectedRows?: unknown } | undefined;
	return first && typeof first.affectedRows === "number" ? first.affectedRows : null;
}

/**
 * How a failed event's writes ended: "clean" is a real rollback (transactional drivers only),
 * "conflict" is a proven duplicate-identity failure — the only kind where the write is guaranteed
 * uncommitted — and "partial" is every other sequential-path failure whose committed prefix
 * honestly stays.
 */
type FailureOutcome = "clean" | "conflict" | "partial";

/** Per-refresh write accounting — every bucket counts only what the driver proved happened. */
export type FeedSyncStats = {
	added: number;
	updated: number;
	unchanged: number;
	removed: number;
	overrides: number;
	/** Events whose row or override row disappeared between the preflight read and the write. */
	vanished: number;
	/** Events whose batch failed (the loop stops at the first one); unattempted counts the rest. */
	failed: number;
	unattempted: number;
};

export type FeedSyncResult = {
	stats: FeedSyncStats;
	/** The first event whose write unit failed, or a prune-stage failure — the run reports it. */
	failure: { stage: "event" | "prune"; outcome: FailureOutcome; detail: string } | null;
	/** The subscription row was deleted underfoot (unsubscribe mid-refresh); nothing was written. */
	unsubscribed: boolean;
};

const emptyStats = (): FeedSyncStats => ({ added: 0, updated: 0, unchanged: 0, removed: 0, overrides: 0, vanished: 0, failed: 0, unattempted: 0 });

/**
 * Writes one feed snapshot over this subscription's rows. An event the feed still describes is
 * inserted or updated; an event the feed dropped is deleted with its overrides (subscription
 * semantics — unlike a file import, which never deletes). Stored overrides on surviving events
 * are reconciled to the feed's set the same way: the feed is the source of truth for every row it
 * owns. Deterministic evt_s_ ids make a repeated refresh idempotent.
 *
 * Each event's master plus its override changes land as one batch so the event is the failure
 * unit — a mid-sync failure leaves complete events and the next refresh converges. Stats are
 * credited only on proof: inserts count when the statement resolves, updates and deletes only on
 * a positive affected-row count, a zero on a row preflight proved existed lands in `vanished`
 * (a concurrent delete took it underfoot), and a transport-level rejection is reported as
 * possibly-applied rather than presumed rolled back.
 */
export async function syncFeedEvents(env: Pick<CloudflareEnv, "DB">, subscription: { id: string }, prepared: PreparedCalendarImport): Promise<FeedSyncResult> {
	const db = getDb(env);
	const stats = emptyStats();
	// Unsubscribe mid-refresh: the owner row must exist before any write, or evt_s_ rows would
	// land with a dangling subscription id. The foreign key is the backstop for the window that
	// remains — an insert under a deleted parent fails rather than orphaning.
	const [owner] = await db.select({ id: calendarSubscriptions.id }).from(calendarSubscriptions).where(eq(calendarSubscriptions.id, subscription.id)).limit(1);
	if (!owner) return { stats, failure: null, unsubscribed: true };
	const existing = await db.select().from(calendarEvents).where(eq(calendarEvents.subscriptionId, subscription.id));
	const existingById = new Map(existing.map((event) => [event.id, event]));
	const preparedIds = new Set(prepared.events.map((event) => event.id));
	const storedOverrides = new Map<string, Map<number, typeof calendarEventOverrides.$inferSelect>>();
	for (const chunk of chunkIds(existing.map((event) => event.id))) {
		for (const row of await db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk))) {
			const perEvent = storedOverrides.get(row.eventId) ?? new Map<number, typeof calendarEventOverrides.$inferSelect>();
			perEvent.set(row.occurrenceMs, row);
			storedOverrides.set(row.eventId, perEvent);
		}
	}
	const wantedByEvent = new Map<string, Map<number, ImportOverrideRow>>();
	for (const override of prepared.overrides) {
		const perEvent = wantedByEvent.get(override.eventId) ?? new Map<number, ImportOverrideRow>();
		perEvent.set(override.occurrenceMs, override);
		wantedByEvent.set(override.eventId, perEvent);
	}
	// On D1 the batch is a real transaction; on an external driver the executor says honestly
	// whether its transaction wrapper gives one — HTTP drivers cannot, so a failed event there
	// leaves a committed prefix that the report admits instead of undoing.
	const executor = isExternalDatabase(env.DB) ? env.DB.sqlExecutor : null;
	const atomic = executor ? (executor.atomicBatch ? await executor.atomicBatch() : executor.transaction !== undefined) : true;
	let failure: FeedSyncResult["failure"] = null;
	for (const [index, event] of prepared.events.entries()) {
		const prior = existingById.get(event.id);
		const stored = storedOverrides.get(event.id) ?? new Map<number, typeof calendarEventOverrides.$inferSelect>();
		const wanted = wantedByEvent.get(event.id) ?? new Map<number, ImportOverrideRow>();
		const statements: BatchItem<"sqlite">[] = [];
		// True for UPDATE/DELETEs aimed at a row the preflight read proved exists: resolving with
		// zero affected rows means a concurrent delete took it underfoot, not that the write landed.
		const mustHit: boolean[] = [];
		let eventOverrides = 0;
		if (!prior) {
			statements.push(db.insert(calendarEvents).values({ ...event, subscriptionId: subscription.id }));
			mustHit.push(false);
		} else if (masterDiffers(prior, event)) {
			statements.push(db.update(calendarEvents).set({ ...masterFields(event), updatedAt: new Date() }).where(eq(calendarEvents.id, event.id)));
			mustHit.push(true);
		}
		for (const [ms, override] of wanted) {
			const before = stored.get(ms);
			if (!before) {
				statements.push(db.insert(calendarEventOverrides).values(override));
				mustHit.push(false);
			} else if (overrideDiffers(before, override)) {
				statements.push(db.update(calendarEventOverrides).set({ startsAt: override.startsAt, endsAt: override.endsAt, title: override.title, description: override.description, location: override.location, updatedAt: new Date() }).where(eq(calendarEventOverrides.id, before.id)));
				mustHit.push(true);
			} else continue;
			eventOverrides += 1;
		}
		for (const [ms, before] of stored) {
			if (!wanted.has(ms)) {
				statements.push(db.delete(calendarEventOverrides).where(eq(calendarEventOverrides.id, before.id)));
				mustHit.push(true);
			}
		}
		if (!statements.length) {
			if (prior) stats.unchanged += 1;
			continue;
		}
		let completed = 0;
		let vanishedAt = -1;
		let results: unknown[] | null = null;
		try {
			if (atomic) {
				results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
				for (const [i, result] of results.entries()) {
					if (mustHit[i] && rowsAffected(result) === 0) { vanishedAt = i; break; }
					completed += 1;
				}
			} else {
				// Sequential-only driver: a failure leaves this sync's own committed prefix — undo
				// could destroy a concurrent writer's work, so nothing is deleted or restored and
				// the run reports the residue honestly. The next refresh converges the event.
				results = [];
				for (const [i, statement] of statements.entries()) {
					const result = results[i] = await statement;
					if (mustHit[i] && rowsAffected(result) === 0) { vanishedAt = i; break; }
					completed += 1;
				}
			}
		} catch (error) {
			// On HTTP drivers a rejected statement only means the response failed — the write may
			// have committed remotely. "conflict" is reserved for a proven unique violation, the
			// one failure kind where the database itself guarantees nothing was written.
			failure = {
				stage: "event",
				outcome: atomic ? "clean" : !prior && completed === 0 && isUniqueConstraintError(error) ? "conflict" : "partial",
				detail: error instanceof Error ? error.message : String(error),
			};
			stats.failed = 1;
			stats.unattempted = prepared.events.length - index - 1;
			break;
		}
		if (vanishedAt >= 0) {
			// A row the preflight read proved was there is gone — deleted between the read and the
			// write. The event is never counted applied; its proven-committed writes are residue
			// the "vanished" bucket admits, and the next refresh converges the rest.
			stats.vanished += 1;
			continue;
		}
		// Every ran statement is proven at this point: inserts resolved, and each must-hit
		// update/delete returned a positive affected count (a zero broke out as vanished above).
		if (!prior) stats.added += 1;
		else stats.updated += 1;
		stats.overrides += eventOverrides;
	}
	// Feed-vanished pruning: the feed owns its evt_s_ rows, so an event absent from the newest
	// snapshot is deleted and its overrides follow by the foreign-key cascade. Only the driver's
	// own affected count is credited — a chunk that hit a concurrent unsubscribe proves zero.
	const vanished = existing.filter((event) => !preparedIds.has(event.id)).map((event) => event.id);
	try {
		for (const chunk of chunkIds(vanished)) {
			const result = await db.delete(calendarEvents).where(inArray(calendarEvents.id, chunk));
			stats.removed += rowsAffected(result) ?? 0;
		}
	} catch (error) {
		// The delete may still have committed across an ambiguous transport — "partial" it is.
		failure ??= { stage: "prune", outcome: "partial", detail: error instanceof Error ? error.message : String(error) };
	}
	return { stats, failure, unsubscribed: false };
}

export type SubscriptionRow = typeof calendarSubscriptions.$inferSelect;

export type RefreshOutcome =
	| { outcome: "not-modified" }
	| { outcome: "synced"; stats: FeedSyncStats; calendarName: string | null }
	| { outcome: "anomaly"; owned: number; detail: string }
	| { outcome: "skipped" }
	| { outcome: "unsubscribed" }
	| { outcome: "failed"; httpStatus: number | null; detail: string };

/**
 * Claims the row for this refresh: the lastRefreshAt stamp moves to `now` only if it still holds
 * the value the caller selected with. A losing compare-and-set means another refresh claimed the
 * feed first (two overlapping ticks or isolates), or the row was deleted — either way this run
 * writes nothing. Cross-isolate serialization lives in the conditional UPDATE itself; there is
 * no in-process lock to fake.
 */
async function claimSubscription(db: ReturnType<typeof getDb>, subscription: SubscriptionRow, now: Date): Promise<boolean> {
	const observed = subscription.lastRefreshAt;
	const result = await db
		.update(calendarSubscriptions)
		.set({ lastRefreshAt: now, updatedAt: now })
		.where(and(eq(calendarSubscriptions.id, subscription.id), observed === null ? isNull(calendarSubscriptions.lastRefreshAt) : eq(calendarSubscriptions.lastRefreshAt, observed)));
	return rowsAffected(result) === 1;
}

/**
 * One conditional fetch -> parse -> sync for a single feed, claimed per subscription so two
 * refreshes of the same feed cannot interleave a snapshot and a prune. A 304 only moves
 * lastRefreshAt; a 200 rewrites the feed's rows; any failure lands on lastError and the feed
 * retries on its next due tick — one bad feed never takes the cron run or its neighbours down.
 * A fetch-level failure (down host, 404, not iCalendar) keeps the stored events: dropping the
 * calendar on a transient upstream error would flap, and unsubscribe is the only delete path.
 */
export async function refreshSubscription(
	env: Pick<CloudflareEnv, "DB" | "MAILFLARE_RUNTIME">,
	subscription: SubscriptionRow,
	options: { floatingZone?: string; fetch?: FeedFetchOptions["fetch"]; resolveHost?: FeedFetchOptions["resolveHost"]; pinConnection?: FeedFetchOptions["pinConnection"]; now?: Date } = {},
): Promise<RefreshOutcome> {
	const db = getDb(env);
	const now = options.now ?? new Date();
	if (!(await claimSubscription(db, subscription, now))) return { outcome: "skipped" };
	const fail = async (httpStatus: number | null, detail: string): Promise<RefreshOutcome> => {
		await db.update(calendarSubscriptions).set({ lastRefreshAt: now, lastRefreshStatus: httpStatus, lastError: detail.slice(0, 500), updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
		return { outcome: "failed", httpStatus, detail };
	};
	let fetched: Awaited<ReturnType<typeof fetchCalendarFeed>>;
	try {
		fetched = await fetchCalendarFeed(subscription.feedUrl, { etag: subscription.etag, lastModified: subscription.lastModified, fetch: options.fetch, resolveHost: options.resolveHost, pinConnection: options.pinConnection, publicEgressAsserted: hasPublicEgressGuarantee(env) });
	} catch (error) {
		if (error instanceof FeedFetchError) return fail(error.httpStatus, error.message);
		throw error;
	}
	if (fetched.outcome === "not-modified") {
		await db.update(calendarSubscriptions).set({ lastRefreshAt: now, lastRefreshStatus: 304, lastError: null, updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
		return { outcome: "not-modified" };
	}
	let prepared: PreparedCalendarImport;
	try {
		prepared = await prepareCalendarImport(fetched.body, { userId: subscription.userId, floatingZone: options.floatingZone, idScheme: subscriptionIdScheme(subscription.userId, subscription.id) });
	} catch (error) {
		return fail(fetched.status, error instanceof Error ? error.message : "Calendar feed could not be imported");
	}
	// Anomaly guard: a syntactically valid snapshot with zero usable events (all cancelled or
	// unsupported) must not prune the calendar — a degraded upstream would erase every row it
	// owns. Keep the prior event set and say so on the row; the validators still advance because
	// the fetch did succeed. Deleting every event on purpose is the unsubscribe path, not a 200.
	if (prepared.events.length === 0) {
		const owned = await db.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.subscriptionId, subscription.id));
		if (owned.length > 0) {
			const detail = `feed returned no usable events; keeping ${owned.length} existing`;
			await db.update(calendarSubscriptions).set({ etag: fetched.etag, lastModified: fetched.lastModified, lastRefreshAt: now, lastRefreshStatus: fetched.status, lastError: detail, updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
			return { outcome: "anomaly", owned: owned.length, detail };
		}
	}
	const result = await syncFeedEvents(env, subscription, prepared);
	if (result.unsubscribed) return { outcome: "unsubscribed" };
	if (result.failure) {
		const detail = `sync ${result.failure.stage} failed (${result.failure.outcome}): ${result.failure.detail}`;
		await db.update(calendarSubscriptions).set({ lastRefreshAt: now, lastRefreshStatus: fetched.status, lastError: detail.slice(0, 500), updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
		return { outcome: "failed", httpStatus: fetched.status, detail };
	}
	await db.update(calendarSubscriptions).set({ etag: fetched.etag, lastModified: fetched.lastModified, lastRefreshAt: now, lastRefreshStatus: fetched.status, lastError: null, eventCount: prepared.events.length, updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
	return { outcome: "synced", stats: result.stats, calendarName: prepared.calendarName };
}

/**
 * Five-minute cron: every feed whose interval elapsed gets a conditional refresh. Feeds belonging
 * to accounts with Calendar disabled are skipped — they cannot show the events anyway. Per-feed
 * failures are recorded on the row and logged, never thrown, so one dead feed cannot starve the
 * others in this tick.
 */
export async function runCalendarSubscriptionRefresh(env: Pick<CloudflareEnv, "DB" | "MAILFLARE_RUNTIME">, now: Date): Promise<void> {
	try {
		const db = getDb(env);
		let cursor = "";
		for (let page = 1; ; page++) {
			const rows = await db
				.select({ subscription: calendarSubscriptions, userTimeZone: users.timeZone })
				.from(calendarSubscriptions)
				// Accounts with Calendar hidden get no refreshes: they cannot open the events anyway.
				.innerJoin(users, and(eq(users.id, calendarSubscriptions.userId), eq(users.calendarEnabled, true)))
				.where(gt(calendarSubscriptions.id, cursor))
				.orderBy(calendarSubscriptions.id)
				.limit(SUBSCRIPTION_PAGE);
			for (const { subscription, userTimeZone } of rows) {
				if (!subscriptionDue(subscription, now)) continue;
				const outcome = await refreshSubscription(env, subscription, { floatingZone: normalizeTimeZone(userTimeZone), now });
				if (outcome.outcome === "failed") console.warn(`Calendar subscription ${subscription.id} refresh failed: ${outcome.detail}`);
				if (outcome.outcome === "anomaly") console.warn(`Calendar subscription ${subscription.id} refresh anomaly: ${outcome.detail}`);
			}
			if (rows.length < SUBSCRIPTION_PAGE) break;
			if (page >= MAX_SUBSCRIPTION_PAGES) {
				console.warn(`Calendar subscription refresh: stopped after ${MAX_SUBSCRIPTION_PAGES * SUBSCRIPTION_PAGE} feeds; later feeds were not checked this run`);
				break;
			}
			cursor = rows[rows.length - 1].subscription.id;
		}
	} catch (error) {
		// Before the calendar_subscriptions migration lands the table does not exist; nothing to refresh yet.
		if (!isMissingTableError(error) && !isMissingColumnError(error)) throw error;
	}
}
