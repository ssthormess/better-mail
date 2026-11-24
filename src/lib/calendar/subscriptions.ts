import { and, eq, gt, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, calendarSubscriptions, users } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
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

export type FeedSyncStats = {
	added: number;
	updated: number;
	unchanged: number;
	removed: number;
	overrides: number;
};

/**
 * Writes one feed snapshot over this subscription's rows. An event the feed still describes is
 * inserted or updated; an event the feed dropped is deleted with its overrides (subscription
 * semantics — unlike a file import, which never deletes). Stored overrides on surviving events
 * are reconciled to the feed's set the same way: the feed is the source of truth for every row it
 * owns. Deterministic evt_s_ ids make a repeated refresh idempotent, and each event's master plus
 * its override changes land as one batch so the event is the failure unit — a mid-sync failure
 * leaves complete events and the next refresh converges.
 */
export async function syncFeedEvents(env: Pick<CloudflareEnv, "DB">, subscription: { id: string }, prepared: PreparedCalendarImport): Promise<FeedSyncStats> {
	const db = getDb(env);
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
	const stats: FeedSyncStats = { added: 0, updated: 0, unchanged: 0, removed: 0, overrides: 0 };
	for (const event of prepared.events) {
		const prior = existingById.get(event.id);
		const stored = storedOverrides.get(event.id) ?? new Map<number, typeof calendarEventOverrides.$inferSelect>();
		const wanted = wantedByEvent.get(event.id) ?? new Map<number, ImportOverrideRow>();
		const statements: BatchItem<"sqlite">[] = [];
		if (!prior) {
			stats.added += 1;
			statements.push(db.insert(calendarEvents).values({ ...event, subscriptionId: subscription.id }));
		} else if (masterDiffers(prior, event)) {
			stats.updated += 1;
			statements.push(db.update(calendarEvents).set({ ...masterFields(event), updatedAt: new Date() }).where(eq(calendarEvents.id, event.id)));
		} else {
			stats.unchanged += 1;
		}
		for (const [ms, override] of wanted) {
			const before = stored.get(ms);
			if (!before) {
				statements.push(db.insert(calendarEventOverrides).values(override));
				stats.overrides += 1;
			} else if (overrideDiffers(before, override)) {
				statements.push(db.update(calendarEventOverrides).set({ startsAt: override.startsAt, endsAt: override.endsAt, title: override.title, description: override.description, location: override.location, updatedAt: new Date() }).where(eq(calendarEventOverrides.id, before.id)));
				stats.overrides += 1;
			}
		}
		for (const [ms, before] of stored) {
			if (!wanted.has(ms)) statements.push(db.delete(calendarEventOverrides).where(eq(calendarEventOverrides.id, before.id)));
		}
		if (statements.length) await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
	}
	// Feed-vanished pruning: the feed owns its evt_s_ rows, so an event absent from the newest
	// snapshot is deleted and its overrides follow by the foreign-key cascade.
	const vanished = existing.filter((event) => !preparedIds.has(event.id)).map((event) => event.id);
	for (const chunk of chunkIds(vanished)) {
		await db.delete(calendarEvents).where(inArray(calendarEvents.id, chunk));
	}
	stats.removed = vanished.length;
	return stats;
}

export type SubscriptionRow = typeof calendarSubscriptions.$inferSelect;

export type RefreshOutcome =
	| { outcome: "not-modified" }
	| { outcome: "synced"; stats: FeedSyncStats; calendarName: string | null }
	| { outcome: "failed"; httpStatus: number | null; detail: string };

/**
 * One conditional fetch -> parse -> sync for a single feed. A 304 only moves lastRefreshAt; a 200
 * rewrites the feed's rows; any failure lands on lastError and the feed retries on its next due
 * tick — one bad feed never takes the cron run or its neighbours down with it. A fetch-level
 * failure (down host, 404, not iCalendar) keeps the stored events: dropping the calendar on a
 * transient upstream error would flap, and unsubscribe is the only delete path.
 */
export async function refreshSubscription(
	env: Pick<CloudflareEnv, "DB">,
	subscription: SubscriptionRow,
	options: { floatingZone?: string; fetch?: FeedFetchOptions["fetch"]; resolveHost?: FeedFetchOptions["resolveHost"]; now?: Date } = {},
): Promise<RefreshOutcome> {
	const db = getDb(env);
	const now = options.now ?? new Date();
	const fail = async (httpStatus: number | null, detail: string): Promise<RefreshOutcome> => {
		await db.update(calendarSubscriptions).set({ lastRefreshAt: now, lastRefreshStatus: httpStatus, lastError: detail.slice(0, 500), updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
		return { outcome: "failed", httpStatus, detail };
	};
	let fetched: Awaited<ReturnType<typeof fetchCalendarFeed>>;
	try {
		fetched = await fetchCalendarFeed(subscription.feedUrl, { etag: subscription.etag, lastModified: subscription.lastModified, fetch: options.fetch, resolveHost: options.resolveHost });
	} catch (error) {
		if (error instanceof FeedFetchError) return fail(error.httpStatus, error.message);
		throw error;
	}
	if (fetched.outcome === "not-modified") {
		await db.update(calendarSubscriptions).set({ lastRefreshAt: now, lastRefreshStatus: 304, lastError: null, updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
		return { outcome: "not-modified" };
	}
	try {
		const prepared = await prepareCalendarImport(fetched.body, { userId: subscription.userId, floatingZone: options.floatingZone, idScheme: subscriptionIdScheme(subscription.userId, subscription.id) });
		const stats = await syncFeedEvents(env, subscription, prepared);
		await db.update(calendarSubscriptions).set({ etag: fetched.etag, lastModified: fetched.lastModified, lastRefreshAt: now, lastRefreshStatus: fetched.status, lastError: null, eventCount: prepared.events.length, updatedAt: now }).where(eq(calendarSubscriptions.id, subscription.id));
		return { outcome: "synced", stats, calendarName: prepared.calendarName };
	} catch (error) {
		if (error instanceof FeedFetchError) return fail(fetched.status, error.message);
		return fail(fetched.status, error instanceof Error ? error.message : "Calendar feed could not be imported");
	}
}

/**
 * Five-minute cron: every feed whose interval elapsed gets a conditional refresh. Feeds belonging
 * to accounts with Calendar disabled are skipped — they cannot show the events anyway. Per-feed
 * failures are recorded on the row and logged, never thrown, so one dead feed cannot starve the
 * others in this tick.
 */
export async function runCalendarSubscriptionRefresh(env: Pick<CloudflareEnv, "DB">, now: Date): Promise<void> {
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
