import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-feeds-ui-utils-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export * from "./src/app/(calendar)/calendar/feeds-utils.ts"; export { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, DEFAULT_REFRESH_INTERVAL_SEC } from "./src/lib/calendar/subscription-constants.ts";`,
		resolveDir: root,
		sourcefile: "feeds-ui-utils-entry.ts",
	},
	outfile: join(dir, "entry.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const {
	FEED_INTERVAL_PRESETS_SEC,
	FEED_DEFAULT_INTERVAL_SEC,
	MIN_REFRESH_INTERVAL_SEC,
	MAX_REFRESH_INTERVAL_SEC,
	DEFAULT_REFRESH_INTERVAL_SEC,
	feedIntervalLabel,
	feedUrlLabel,
	feedHealth,
	feedErrorMessage,
	readFeedResponse,
	FeedRequestError,
} = await import(pathToFileURL(join(dir, "entry.mjs")).href);

// Translator stub: echos the key and its vars so assertions can match without a catalog.
const t = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

test("interval presets stay inside the server's accepted range and default matches", () => {
	for (const seconds of FEED_INTERVAL_PRESETS_SEC) {
		assert.ok(seconds >= MIN_REFRESH_INTERVAL_SEC, `${seconds} >= ${MIN_REFRESH_INTERVAL_SEC}`);
		assert.ok(seconds <= MAX_REFRESH_INTERVAL_SEC, `${seconds} <= ${MAX_REFRESH_INTERVAL_SEC}`);
	}
	assert.deepEqual(FEED_INTERVAL_PRESETS_SEC, [...FEED_INTERVAL_PRESETS_SEC].sort((a, b) => a - b));
	assert.equal(FEED_DEFAULT_INTERVAL_SEC, DEFAULT_REFRESH_INTERVAL_SEC);
	assert.ok(FEED_INTERVAL_PRESETS_SEC.includes(FEED_DEFAULT_INTERVAL_SEC));
});

test("feedIntervalLabel picks fixed keys for whole units and {count} for multiples", () => {
	assert.equal(feedIntervalLabel(604800, t), "calendar.feeds.every.week");
	assert.equal(feedIntervalLabel(86400, t), "calendar.feeds.every.day");
	assert.equal(feedIntervalLabel(172800, t), 'calendar.feeds.every.days({"count":2})');
	assert.equal(feedIntervalLabel(3600, t), "calendar.feeds.every.hour");
	assert.equal(feedIntervalLabel(21600, t), 'calendar.feeds.every.hours({"count":6})');
	assert.equal(feedIntervalLabel(900, t), 'calendar.feeds.every.minutes({"count":15})');
	assert.equal(feedIntervalLabel(45, t), 'calendar.feeds.every.seconds({"count":45})');
});

test("feedUrlLabel shows host + path, truncates long paths, and passes unparseable input through", () => {
	assert.equal(feedUrlLabel("https://example.com/"), "example.com");
	assert.equal(feedUrlLabel("webcal://example.com/calendar.ics"), "example.com/calendar.ics");
	const longPath = `/${"a".repeat(60)}`;
	const labelled = feedUrlLabel(`https://example.com${longPath}`);
	assert.equal(labelled, `example.com/${"a".repeat(47)}…`);
	assert.equal(feedUrlLabel("not a url"), "not a url");
});

test("feedHealth separates never-run, clean, anomaly-warning and failed", () => {
	assert.equal(feedHealth({ lastRefreshAt: null, lastRefreshStatus: null, lastError: null }), "pending");
	assert.equal(feedHealth({ lastRefreshAt: "2026-01-01T00:00:00Z", lastRefreshStatus: 200, lastError: null }), "ok");
	assert.equal(feedHealth({ lastRefreshAt: "2026-01-01T00:00:00Z", lastRefreshStatus: 304, lastError: null }), "ok");
	// The "feed returned no usable events" anomaly is a 2xx fetch + error text: a warning, not a failure.
	assert.equal(feedHealth({ lastRefreshAt: "2026-01-01T00:00:00Z", lastRefreshStatus: 200, lastError: "feed returned no usable events; keeping 12 existing" }), "warning");
	assert.equal(feedHealth({ lastRefreshAt: "2026-01-01T00:00:00Z", lastRefreshStatus: 502, lastError: "bad gateway" }), "error");
	assert.equal(feedHealth({ lastRefreshAt: "2026-01-01T00:00:00Z", lastRefreshStatus: null, lastError: "pinning_unavailable" }), "error");
});

test("feedErrorMessage maps statuses and API codes to copy and passes detail through", () => {
	const cases = [
		[new FeedRequestError(409, "Already subscribed"), "calendar.feeds.error.duplicate"],
		[new FeedRequestError(504, "FEED_FETCH_FAILED"), "calendar.feeds.error.timeout"],
		[new FeedRequestError(413, "FEED_LIMIT_EXCEEDED"), "calendar.feeds.error.tooLarge"],
		[new FeedRequestError(400, "INVALID_ICS"), "calendar.feeds.error.invalidIcs"],
		[new FeedRequestError(500, "FEED_SYNC_FAILED"), "calendar.feeds.error.syncFailed"],
		[new FeedRequestError(502, "FEED_FETCH_FAILED"), "calendar.feeds.error.fetchFailed"],
	];
	for (const [error, expected] of cases) assert.equal(feedErrorMessage(error, t, "fb").message, expected);
	// Unknown codes surface the server's own message; non-API errors use the caller's fallback.
	assert.equal(feedErrorMessage(new FeedRequestError(400, "Only public calendar feeds are supported"), t, "fb").message, "Only public calendar feeds are supported");
	assert.equal(feedErrorMessage(new TypeError("fetch failed"), t, "fb").message, "fb");
	// `detail` rides along as the secondary line when the API sends it.
	const withDetail = feedErrorMessage(new FeedRequestError(504, "FEED_FETCH_FAILED", "timed out after 15s"), t, "fb");
	assert.equal(withDetail.detail, "timed out after 15s");
});

test("readFeedResponse returns null on success and FeedRequestError with error/detail on failure", async () => {
	assert.equal(await readFeedResponse(new Response("{}", { status: 200 })), null);
	const err = await readFeedResponse(new Response(JSON.stringify({ error: "FEED_LIMIT_EXCEEDED", detail: "64 KiB max" }), { status: 413 }));
	assert.ok(err instanceof FeedRequestError);
	assert.equal(err.status, 413);
	assert.equal(err.apiError, "FEED_LIMIT_EXCEEDED");
	assert.equal(err.detail, "64 KiB max");
	// A non-JSON body still yields a usable error rather than throwing.
	const bad = await readFeedResponse(new Response("nope", { status: 500 }));
	assert.equal(bad.apiError, null);
	assert.equal(bad.status, 500);
});
