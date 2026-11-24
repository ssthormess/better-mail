import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarSubscriptions } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { readJsonObject } from "@/lib/http/request";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { getRequestTimeZone } from "@/lib/time/utils";
import { hasPublicEgressGuarantee } from "@/lib/runtime";
import { fetchCalendarFeed, FeedFetchError, normalizeFeedUrl } from "@/lib/calendar/subscription-feed";
import { IcsLimitError, IcsParseError, prepareCalendarImport } from "@/lib/calendar/ics-import";
import { MAX_REFRESH_INTERVAL_SEC, MIN_REFRESH_INTERVAL_SEC, normalizeRefreshIntervalSec, subscriptionIdScheme, syncFeedEvents } from "@/lib/calendar/subscriptions";

type SubscriptionInput = { url?: unknown; title?: unknown; refreshIntervalSec?: unknown };

/**
 * Maps a feed-fetch failure to the client response: URL-side rejections are the caller's bad
 * request and answer with the plain reason like the other 400s; upstream trouble reports the
 * fetch code so a feed that was working and then broke reads differently than a URL typo.
 */
function feedErrorResponse(error: FeedFetchError): NextResponse {
	if (error.code === "invalid_url" || error.code === "not_public") return NextResponse.json({ error: error.message }, { status: 400 });
	if (error.code === "too_large") return NextResponse.json({ error: "FEED_LIMIT_EXCEEDED", detail: error.message }, { status: 413 });
	return NextResponse.json({ error: "FEED_FETCH_FAILED", detail: error.message }, { status: error.code === "timeout" ? 504 : 502 });
}

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:read");
	if (error) return error;
	const subscriptions = await getDb(env).select().from(calendarSubscriptions).where(eq(calendarSubscriptions.userId, user.id)).orderBy(calendarSubscriptions.createdAt);
	return NextResponse.json({ subscriptions });
}

/**
 * Subscribes to an external webcal/https feed: the URL is canonicalized (webcal becomes https),
 * the feed is fetched once through the SSRF guard and parsed, and the subscription row lands only
 * if that first snapshot imports — subscribing to a broken or empty URL fails instead of leaving
 * a dead row. The five-minute cron takes over refreshes from there.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const input = await readJsonObject<SubscriptionInput>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
	if (!rawUrl) return NextResponse.json({ error: "Enter a calendar feed URL" }, { status: 400 });
	let feedUrl: string;
	try {
		feedUrl = normalizeFeedUrl(rawUrl).href;
	} catch (urlError) {
		return NextResponse.json({ error: urlError instanceof FeedFetchError ? urlError.message : "Enter a valid calendar feed URL" }, { status: 400 });
	}
	const refreshIntervalSec = normalizeRefreshIntervalSec(input.refreshIntervalSec);
	if (refreshIntervalSec === null) {
		return NextResponse.json({ error: `Refresh interval must be ${MIN_REFRESH_INTERVAL_SEC}-${MAX_REFRESH_INTERVAL_SEC} seconds` }, { status: 400 });
	}
	const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
	const db = getDb(env);
	const [dupe] = await db.select({ id: calendarSubscriptions.id }).from(calendarSubscriptions).where(and(eq(calendarSubscriptions.userId, user.id), eq(calendarSubscriptions.feedUrl, feedUrl))).limit(1);
	if (dupe) return NextResponse.json({ error: "Already subscribed to this feed" }, { status: 409 });
	let fetched;
	try {
		fetched = await fetchCalendarFeed(feedUrl, { publicEgressAsserted: hasPublicEgressGuarantee(env) });
	} catch (fetchError) {
		if (fetchError instanceof FeedFetchError) return feedErrorResponse(fetchError);
		throw fetchError;
	}
	// No validators were sent, so a 304 would be a malformed answer rather than a cheap tick.
	if (fetched.outcome !== "fetched") {
		return NextResponse.json({ error: "FEED_FETCH_FAILED", detail: "Calendar feed returned an unusable response" }, { status: 502 });
	}
	// The subscription id folds into every event's identity hash, so it is minted before the parse.
	const subscriptionId = newId("sub");
	let prepared;
	try {
		prepared = await prepareCalendarImport(fetched.body, { userId: user.id, floatingZone: getRequestTimeZone(request, user.timeZone), idScheme: subscriptionIdScheme(user.id, subscriptionId) });
	} catch (parseError) {
		if (parseError instanceof IcsLimitError) return NextResponse.json({ error: "FEED_LIMIT_EXCEEDED", detail: parseError.message }, { status: 413 });
		if (parseError instanceof IcsParseError) return NextResponse.json({ error: "INVALID_ICS", detail: parseError.message }, { status: 400 });
		throw parseError;
	}
	const subscription = {
		id: subscriptionId,
		userId: user.id,
		feedUrl,
		title: title || prepared.calendarName || new URL(feedUrl).hostname,
		etag: fetched.etag,
		lastModified: fetched.lastModified,
		refreshIntervalSec,
		lastRefreshAt: new Date(),
		lastRefreshStatus: fetched.status,
		lastError: null,
		eventCount: prepared.events.length,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	let synced;
	try {
		await db.insert(calendarSubscriptions).values(subscription);
		synced = await syncFeedEvents(env, subscription, prepared);
	} catch (writeError) {
		// Roll the row back so a half-written subscription does not sit there waiting on the cron.
		await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.id, subscription.id)).catch(() => undefined);
		if (isUniqueConstraintError(writeError)) return NextResponse.json({ error: "Already subscribed to this feed" }, { status: 409 });
		throw writeError;
	}
	if (synced.failure || synced.unsubscribed) {
		await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.id, subscription.id)).catch(() => undefined);
		return NextResponse.json({ error: "FEED_SYNC_FAILED", detail: `Calendar feed events could not be written${synced.failure ? ` (${synced.failure.outcome})` : ""}` }, { status: 500 });
	}
	return NextResponse.json({ subscription, added: synced.stats.added, skipped: prepared.skipped + synced.stats.unchanged, errors: prepared.errors });
}
