import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Client-side recurrence expansion: feed-owned rows must expand on the source's wall clock
// (stored timeZone, NULL = the importer's UTC marker) so displayed instants match the server
// and detached overrides/exclusions line up. Personal rows keep floating in the viewer's
// account zone — the legacy-freeze contract — so a NULL-zone personal series still shifts
// with the preference.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "node_modules", "mailflare-feed-expansion-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export { expandCalendarEvents, nextCalendarOccurrence } from "./src/app/(calendar)/calendar/utils.ts"; export { clearUserTimeZoneCache } from "./src/lib/time/utils.ts"; export { prepareCalendarImport } from "./src/lib/calendar/ics-import.ts";`,
		resolveDir: root,
		sourcefile: "feed-expansion-entry.ts",
	},
	outfile: join(dir, "entry.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { expandCalendarEvents, nextCalendarOccurrence, clearUserTimeZoneCache, prepareCalendarImport } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

const ics = (lines) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const vevent = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

const viewerZone = (timeZone) => {
	globalThis.window = { localStorage: { getItem: () => JSON.stringify({ timeZone }) } };
	clearUserTimeZoneCache();
};

// expandCalendarEvents consumes the GET response shape: instants arrive as ISO strings.
const row = (event, extra = {}) => ({ ...event, ...extra, startsAt: event.startsAt.toISOString(), endsAt: event.endsAt.toISOString() });
const instants = (events, start, end, overrides) =>
	expandCalendarEvents(events, new Date(start), new Date(end), overrides).map((occurrence) => new Date(occurrence.startsAt).toISOString());

const importOne = async (feed) => (await prepareCalendarImport(ics(feed), { userId: "user-1", floatingZone: "America/New_York" })).events[0];

test("a UTC feed series expands to the same instants under any viewer zone", async () => {
	const event = await importOne(vevent(["UID:utc", "DTSTART:20260102T170000Z", "DTEND:20260102T180000Z", "SUMMARY:UTC feed", "RRULE:FREQ=WEEKLY"]));
	assert.equal(event.timeZone, null);
	const feed = [row(event, { subscriptionId: "sub_1" })];
	for (const preference of ["America/New_York", "UTC"]) {
		viewerZone(preference);
		assert.deepEqual(instants(feed, "2026-07-02T00:00:00Z", "2026-07-05T00:00:00Z"), ["2026-07-03T17:00:00.000Z"], preference);
	}
});

test("a TZID feed series keeps source-zone instants across a DST boundary", async () => {
	const event = await importOne(vevent(["UID:ny", "DTSTART;TZID=America/New_York:20261020T130000", "DTEND;TZID=America/New_York:20261020T140000", "SUMMARY:NY feed", "RRULE:FREQ=WEEKLY"]));
	assert.equal(event.timeZone, "America/New_York");
	const feed = [row(event, { subscriptionId: "sub_1" })];
	// 13:00 New York wall clock, every Tuesday: EDT (UTC-4) before the Nov 1 fallback, EST (UTC-5) after.
	const expected = ["2026-10-27T17:00:00.000Z", "2026-11-03T18:00:00.000Z"];
	for (const preference of ["America/New_York", "UTC"]) {
		viewerZone(preference);
		assert.deepEqual(instants(feed, "2026-10-25T00:00:00Z", "2026-11-04T00:00:00Z"), expected, preference);
	}
});

test("a detached override keyed by the source-zone instant lands on its rule occurrence", async () => {
	const event = await importOne(vevent(["UID:utc", "DTSTART:20260102T170000Z", "DTEND:20260102T180000Z", "SUMMARY:UTC feed", "RRULE:FREQ=WEEKLY"]));
	const feed = [row(event, { subscriptionId: "sub_1" })];
	const occurrenceMs = Date.parse("2026-07-03T17:00:00.000Z");
	const moved = new Map([[event.id, [{ occurrenceMs, startsAt: new Date("2026-07-03T19:00:00Z"), endsAt: new Date("2026-07-03T20:00:00Z") }]]]);
	for (const preference of ["America/New_York", "UTC"]) {
		viewerZone(preference);
		// One moved occurrence — no phantom original left behind at the rule instant.
		assert.deepEqual(instants(feed, "2026-07-02T00:00:00Z", "2026-07-05T00:00:00Z", moved), ["2026-07-03T19:00:00.000Z"], preference);
	}
});

test("personal NULL-zone series still float with the viewer zone", async () => {
	const event = await importOne(vevent(["UID:personal", "DTSTART:20260102T170000Z", "DTEND:20260102T180000Z", "SUMMARY:Personal", "RRULE:FREQ=WEEKLY"]));
	const personal = [row(event)];
	viewerZone("America/New_York");
	assert.deepEqual(instants(personal, "2026-07-02T00:00:00Z", "2026-07-05T00:00:00Z"), ["2026-07-03T16:00:00.000Z"]);
	viewerZone("UTC");
	assert.deepEqual(instants(personal, "2026-07-02T00:00:00Z", "2026-07-05T00:00:00Z"), ["2026-07-03T17:00:00.000Z"]);
});

test("nextCalendarOccurrence uses the source zone for feed rows too", async () => {
	const event = await importOne(vevent(["UID:utc", "DTSTART:20260102T170000Z", "DTEND:20260102T180000Z", "SUMMARY:UTC feed", "RRULE:FREQ=WEEKLY"]));
	const feed = row(event, { subscriptionId: "sub_1" });
	for (const preference of ["America/New_York", "UTC"]) {
		viewerZone(preference);
		assert.equal(nextCalendarOccurrence(feed, new Date("2026-07-02T00:00:00Z"))?.toISOString(), "2026-07-03T17:00:00.000Z", preference);
	}
});
