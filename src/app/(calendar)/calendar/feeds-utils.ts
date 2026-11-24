import { DEFAULT_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, MIN_REFRESH_INTERVAL_SEC } from "@/lib/calendar/subscription-constants";
import type { Translator } from "@/lib/i18n/utils";
import type { CalendarSubscription } from "./feeds-types";

/** Interval choices in the subscribe and edit selects, clipped to the server's accepted range. */
export const FEED_INTERVAL_PRESETS_SEC = [900, 3600, 21600, 86400, 604800].filter(
	(seconds) => seconds >= MIN_REFRESH_INTERVAL_SEC && seconds <= MAX_REFRESH_INTERVAL_SEC,
);
export const FEED_DEFAULT_INTERVAL_SEC = DEFAULT_REFRESH_INTERVAL_SEC;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;

/** Humanizes the stored seconds the same way the booking durations do — fixed keys, count var. */
export function feedIntervalLabel(seconds: number, t: Translator): string {
	if (seconds === SECONDS_PER_WEEK) return t("calendar.feeds.every.week");
	if (seconds % SECONDS_PER_DAY === 0) return seconds === SECONDS_PER_DAY ? t("calendar.feeds.every.day") : t("calendar.feeds.every.days", { count: seconds / SECONDS_PER_DAY });
	if (seconds % SECONDS_PER_HOUR === 0) return seconds === SECONDS_PER_HOUR ? t("calendar.feeds.every.hour") : t("calendar.feeds.every.hours", { count: seconds / SECONDS_PER_HOUR });
	if (seconds % SECONDS_PER_MINUTE === 0) return t("calendar.feeds.every.minutes", { count: seconds / SECONDS_PER_MINUTE });
	return t("calendar.feeds.every.seconds", { count: seconds });
}

/** host + path shortened for one line; the row keeps the full URL in `title` for hover/copy. */
export function feedUrlLabel(feedUrl: string): string {
	try {
		const url = new URL(feedUrl);
		const path = `${url.pathname}${url.search}`;
		return path === "/" ? url.hostname : `${url.hostname}${path.length > 48 ? `${path.slice(0, 48)}…` : path}`;
	} catch {
		return feedUrl;
	}
}

/**
 * How a feed row reads: `lastError` is also set by the keep-existing anomaly (a 2xx fetch that
 * delivered no usable events), so a warning stays distinct from a fetch failure. `pending` is
 * a feed whose first refresh has not run yet.
 */
export function feedHealth(subscription: Pick<CalendarSubscription, "lastRefreshAt" | "lastRefreshStatus" | "lastError">): "ok" | "warning" | "error" | "pending" {
	if (!subscription.lastRefreshAt) return "pending";
	if (!subscription.lastError) return "ok";
	const status = subscription.lastRefreshStatus;
	return status !== null && status >= 200 && status < 400 ? "warning" : "error";
}

/** A rejected subscriptions API call: `status`, the API `error` field and its optional `detail`. */
export class FeedRequestError extends Error {
	constructor(
		readonly status: number,
		readonly apiError: string | null,
		readonly detail?: string,
	) {
		super(apiError ?? `HTTP ${status}`);
		this.name = "FeedRequestError";
	}
}

/** The POST/PATCH errors the API reports as codes (`error`) with a technical `detail`. */
const CODE_ERROR_KEYS: Record<string, "calendar.feeds.error.tooLarge" | "calendar.feeds.error.fetchFailed" | "calendar.feeds.error.invalidIcs" | "calendar.feeds.error.syncFailed"> = {
	FEED_LIMIT_EXCEEDED: "calendar.feeds.error.tooLarge",
	FEED_FETCH_FAILED: "calendar.feeds.error.fetchFailed",
	INVALID_ICS: "calendar.feeds.error.invalidIcs",
	FEED_SYNC_FAILED: "calendar.feeds.error.syncFailed",
};

/**
 * Maps a failed call to display copy: stable API codes and statuses get translated text (the
 * `detail`, when sent, stays as a secondary line); anything else is the server's own sentence —
 * the 400 reasons already read like UI copy, same convention as the event editor.
 */
export function feedErrorMessage(error: unknown, t: Translator, fallback: string): { message: string; detail?: string } {
	if (error instanceof FeedRequestError) {
		if (error.status === 409) return { message: t("calendar.feeds.error.duplicate"), detail: error.detail };
		if (error.status === 504) return { message: t("calendar.feeds.error.timeout"), detail: error.detail };
		const key = error.apiError ? CODE_ERROR_KEYS[error.apiError] : undefined;
		if (key) return { message: t(key), detail: error.detail };
		if (error.apiError) return { message: error.apiError, detail: error.detail };
	}
	return { message: fallback };
}

/** Parses a route response into the error the UI maps, or null when the call succeeded. */
export async function readFeedResponse(response: Response): Promise<FeedRequestError | null> {
	if (response.ok) return null;
	const body = await response.json().catch(() => ({})) as { error?: unknown; detail?: unknown };
	return new FeedRequestError(
		response.status,
		typeof body.error === "string" ? body.error : null,
		typeof body.detail === "string" ? body.detail : undefined,
	);
}
