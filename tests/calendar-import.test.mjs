import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// POST /api/import/calendar writes user events from an .ics upload; it is the inverse of the
// GET /api/export/calendar download, so the same fixture round-trips field-for-field.
const mocks = {
	"@/lib/cloudflare": `export function getEnv(){return globalThis.calImportEnv}`,
	"@/lib/auth/cookies": `export async function getCurrentUser(){return globalThis.calImportUser}`,
	"@/lib/api/key-auth": `export async function authenticateApiRequest(){return globalThis.calImportKey} export async function authenticateApiKeyValue(){return null} export function hasScope(scopes,required){return scopes.includes(required)||scopes.includes("*")}`,
};
const { app, newDatabase } = await loadApp("cal-import", `
	export * as route from "./src/app/api/import/calendar/route.ts";
	export * as exportRoute from "./src/app/api/export/calendar/route.ts";
	export { normalizeCalendarColor } from "./src/lib/calendar/colors.ts";
	export { MAX_IMPORT_EVENTS } from "./src/lib/calendar/ics-import.ts";
	export { buildCalendarFeed } from "./src/lib/calendar/feed.ts";
`, { mocks });

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const monday = sec("2026-11-02T17:00:00Z"); // 09:00 in America/Los_Angeles

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('user-1', 'u@example.com', 'hash', 'User', 'user', 1),
		('user-2', 'v@example.com', 'hash', 'Empty', 'user', 1);
	INSERT INTO calendar_events (id, user_id, title, description, location, attendees, repeat, repeat_days, repeat_anchor_day, repeat_until, repeat_interval, repeat_weekday, repeat_week, excluded_occurrences, time_zone, reminder_minutes, starts_at, ends_at, created_at, updated_at) VALUES
		('evt-one', 'user-1', 'One, off; "quoted"', 'Line one\nLine two, é', 'Room, 2', '["Guest@Example.com ","other@example.com","not-an-email"]', 'none', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, 15, ${sec("2026-11-03T17:00:00Z")}, ${sec("2026-11-03T18:00:00Z")}, 1, 1),
		('evt-daily', 'user-1', 'Every other day', '', '', '[]', 'daily', '[]', NULL, ${sec("2026-11-10T17:00:00Z")}, 2, NULL, NULL, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-weekly', 'user-1', 'Weekly sync', 'Weekly notes', '', '[]', 'weekly', '[]', NULL, NULL, 1, NULL, NULL, '[${Date.parse("2026-11-09T17:00:00Z")}]', 'America/Los_Angeles', NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-weekdays', 'user-1', 'Mon Wed Fri', '', '', '[]', 'weekdays', '[1,3,5]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-monthly', 'user-1', 'Monthly', '', '', '[]', 'monthly', '[]', 15, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-monthly31', 'user-1', 'End of month', '', '', '[]', 'monthly', '[]', 31, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-nth', 'user-1', 'Second Tuesday', '', '', '[]', 'monthly', '[]', NULL, NULL, 1, 2, 2, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-fifth', 'user-1', 'Fifth Monday', '', '', '[]', 'monthly', '[]', NULL, NULL, 1, 1, 5, '[]', NULL, NULL, ${sec("2026-03-30T17:00:00Z")}, ${sec("2026-03-30T17:30:00Z")}, 1, 1),
		('evt-leap', 'user-1', 'Leap day', '', '', '[]', 'yearly', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${sec("2024-02-29T17:00:00Z")}, ${sec("2024-02-29T17:30:00Z")}, 1, 1),
		('evt-yearly', 'user-1', 'Yearly', '', '', '[]', 'yearly', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-count', 'user-1', 'Count ten', '', '', '[]', 'daily', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${monday}, ${monday + 1800}, 1, 1),
		('evt-old', 'user-1', 'Since 1970', '', '', '[]', 'daily', '[]', NULL, NULL, 1, NULL, NULL, '[]', NULL, NULL, ${sec("1970-01-01T17:00:00Z")}, ${sec("1970-01-01T18:00:00Z")}, 1, 1);
	INSERT INTO calendar_event_overrides (id, event_id, occurrence_ms, starts_at, ends_at, title, description, location, created_at, updated_at) VALUES
		('ov-1', 'evt-weekly', ${Date.parse("2026-11-16T17:00:00Z")}, ${sec("2026-11-16T19:00:00Z")}, ${sec("2026-11-16T20:00:00Z")}, 'Moved sync', NULL, 'Video', 1, 1),
		('ov-2', 'evt-weekly', ${Date.parse("2026-11-12T17:00:00Z")}, ${sec("2026-11-12T17:00:00Z")}, ${sec("2026-11-12T17:30:00Z")}, NULL, NULL, NULL, 1, 1),
		('ov-4', 'evt-weekdays', ${Date.parse("2026-11-05T17:00:00Z")}, ${sec("2026-11-05T17:00:00Z")}, ${sec("2026-11-05T17:30:00Z")}, NULL, NULL, NULL, 1, 1),
		('ov-5', 'evt-old', ${Date.parse("1970-01-01T17:00:00Z") + 20000 * 86400000}, ${sec("2024-10-04T19:00:00Z")}, ${sec("2024-10-04T20:00:00Z")}, 'Still edited', NULL, NULL, 1, 1);
`;

const sessionUser = { id: "user-1", calendarEnabled: true, timeZone: "UTC" };
const secondUser = { id: "user-2", calendarEnabled: true, timeZone: "UTC" };
const keyWith = (scopes, user = sessionUser) => ({ keyId: "k1", userId: user.id, scopes, mailboxIds: null, user });
const req = (body, headers = {}) => new Request("http://localhost/api/import/calendar", { method: "POST", headers: { "content-type": "text/calendar", ...headers }, body });

async function setup(t, { user = sessionUser, key = null, seedSql = seed } = {}) {
	const { env, sqlite } = await newDatabase(t, seedSql);
	globalThis.calImportEnv = env;
	globalThis.calImportUser = user;
	globalThis.calImportKey = key;
	return sqlite;
}

const ics = (lines) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${lines.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const vevent = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

const eventsOf = (sqlite, userId) => sqlite.prepare("SELECT * FROM calendar_events WHERE user_id = ? ORDER BY title").all(userId);
const overridesOf = (sqlite, eventId) => sqlite.prepare("SELECT * FROM calendar_event_overrides WHERE event_id = ? ORDER BY occurrence_ms").all(eventId);

test("a session user imports a raw text/calendar body", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const res = await app.route.POST(req(ics(vevent(["UID:a-1", "DTSTART:20261103T170000Z", "DTEND:20261103T180000Z", "SUMMARY:Hello"]))));
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.imported, 1);
	assert.equal(body.skipped, 0);
	assert.deepEqual(body.errors, []);
	const [event] = eventsOf(sqlite, "user-2");
	assert.equal(event.title, "Hello");
	assert.equal(event.starts_at, sec("2026-11-03T17:00:00Z"));
	assert.equal(event.ends_at, sec("2026-11-03T18:00:00Z"));
	// Imported events are user events: the invitation columns stay at their defaults.
	assert.equal(event.response_status, null);
	assert.equal(event.invite_sender, null);
	assert.equal(event.event_sequence, 0);
});

test("a Bearer key needs the calendar:write scope", async (t) => {
	const body = ics(vevent(["UID:a-1", "DTSTART:20261103T170000Z", "SUMMARY:x"]));
	await setup(t, { user: null, key: keyWith(["calendar:read"]) });
	assert.equal((await app.route.POST(req(body, { authorization: "Bearer ep_k" }))).status, 403);
	await setup(t, { user: null, key: keyWith(["calendar:write"], secondUser) });
	assert.equal((await app.route.POST(req(body, { authorization: "Bearer ep_k" }))).status, 200);
});

test("no session and no key is a 401", async (t) => {
	await setup(t, { user: null });
	assert.equal((await app.route.POST(req(ics(vevent(["UID:x", "DTSTART:20261103T170000Z", "SUMMARY:x"]))))).status, 401);
});

test("malformed input gets a clean 4xx, never a 500", async (t) => {
	await setup(t);
	for (const [body, error] of [
		["this is not ics", "INVALID_ICS"],
		["", "Empty calendar file"],
		["   ", "Empty calendar file"],
		[ics([]), "INVALID_ICS"], // parses, but holds no events
	]) {
		const res = await app.route.POST(req(body));
		assert.equal(res.status, 400, `status for ${JSON.stringify(body.slice(0, 30))}`);
		assert.equal((await res.json()).error, error);
	}
	// A VEVENT without DTSTART is skipped per event, not a whole-file failure.
	const res = await app.route.POST(req(ics([...vevent(["UID:no-dt", "SUMMARY:no dtstart"]), ...vevent(["UID:ok", "DTSTART:20261103T170000Z", "SUMMARY:ok"])])));
	assert.equal(res.status, 200);
	const json = await res.json();
	assert.equal(json.imported, 1);
	assert.equal(json.skipped, 1);
	assert.ok(json.errors.some((e) => e.includes("no-dt")));
});

test("oversized input fails explicitly with IMPORT_LIMIT_EXCEEDED", async (t) => {
	await setup(t);
	const res = await app.route.POST(req("BEGIN:VCALENDAR", { "content-length": String(5 * 1024 * 1024) }));
	assert.equal(res.status, 413);
	assert.equal((await res.json()).error, "IMPORT_LIMIT_EXCEEDED");
});

test("more than MAX_IMPORT_EVENTS events fails explicitly", async (t) => {
	await setup(t);
	const vevents = Array.from({ length: app.MAX_IMPORT_EVENTS + 1 }, (_, i) => vevent([`UID:m-${i}`, "DTSTART:20261103T170000Z", "SUMMARY:x"])).flat();
	const res = await app.route.POST(req(ics(vevents)));
	assert.equal(res.status, 413);
	assert.equal((await res.json()).error, "IMPORT_LIMIT_EXCEEDED");
});

test("a multipart file upload imports the same way", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const form = new FormData();
	form.append("file", new File([ics(vevent(["UID:mp-1", "DTSTART:20261103T170000Z", "SUMMARY:from file"]))], "cal.ics", { type: "text/calendar" }));
	const res = await app.route.POST(new Request("http://localhost/api/import/calendar", { method: "POST", body: form }));
	assert.equal(res.status, 200);
	assert.equal((await res.json()).imported, 1);
	assert.equal(eventsOf(sqlite, "user-2")[0].title, "from file");
});

test("re-importing an unchanged file is a no-op, not a second copy", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const body = ics(vevent(["UID:dup", "DTSTART:20261103T170000Z", "SUMMARY:dup"]));
	assert.equal((await (await app.route.POST(req(body))).json()).imported, 1);
	const again = await (await app.route.POST(req(body))).json();
	assert.equal(again.imported, 0);
	assert.equal(again.updated, 0);
	assert.equal(again.skipped, 1);
	assert.equal(eventsOf(sqlite, "user-2").length, 1);
	// The same file for another user is its own event: ids are scoped per user.
	globalThis.calImportUser = sessionUser;
	const other = await (await app.route.POST(req(body))).json();
	assert.equal(other.imported, 1);
	assert.equal(eventsOf(sqlite, "user-1").filter((event) => event.title === "dup").length, 1);
});

const L = (...lines) => `${lines.join("\r\n")}\r\n`;
const googleFixture = L(
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
	"BEGIN:VTIMEZONE", "TZID:America/New_York",
	"BEGIN:STANDARD", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "END:STANDARD",
	"BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "END:DAYLIGHT",
	"END:VTIMEZONE",
	...vevent(["UID:g-1", "DTSTAMP:20261101T000000Z", "DTSTART;TZID=America/New_York:20261104T090000", "DTEND;TZID=America/New_York:20261104T100000", "SUMMARY:Google weekly", "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6", "EXDATE;TZID=America/New_York:20261111T090000"]),
	...vevent(["UID:g-1", "RECURRENCE-ID;TZID=America/New_York:20261118T090000", "DTSTART;TZID=America/New_York:20261118T110000", "DTEND;TZID=America/New_York:20261118T120000", "SUMMARY:Google weekly moved"]),
	// Feb-29 yearly, foreign form (no BYMONTH/BYSETPOS encoding).
	...vevent(["UID:f-leap", "DTSTART:20240229T090000Z", "DTEND:20240229T100000Z", "SUMMARY:leap", "RRULE:FREQ=YEARLY"]),
	// Fifth-weekday monthly clamps to "last" like the app's own 5 does.
	...vevent(["UID:f-5th", "DTSTART:20260330T090000Z", "DTEND:20260330T100000Z", "SUMMARY:fifth", "RRULE:FREQ=MONTHLY;BYDAY=5MO"]),
	// A detached occurrence on no rule instant becomes an extra occurrence.
	...vevent(["UID:f-det", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:det master", "RRULE:FREQ=WEEKLY"]),
	...vevent(["UID:f-det", "RECURRENCE-ID:20261105T090000Z", "DTSTART:20261105T150000Z", "DTEND:20261105T160000Z", "SUMMARY:det extra", "DESCRIPTION:moved"]),
	// Floating time resolves in the request/user zone (America/New_York here).
	...vevent(["UID:f-float", "DTSTART:20261103T090000", "DTEND:20261103T100000", "SUMMARY:floating"]),
	// All-day DATE events become midnight to midnight in the resolved zone.
	...vevent(["UID:f-day", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106", "SUMMARY:all day"]),
	// A display alarm maps to reminder minutes; other actions are noted and skipped.
	...vevent(["UID:f-alarm", "DTSTART:20261103T090000Z", "SUMMARY:alarmed", "BEGIN:VALARM", "ACTION:EMAIL", "TRIGGER:-PT10M", "END:VALARM", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "END:VALARM"]),
	// A rule the model cannot express degrades to a single occurrence with a note.
	...vevent(["UID:f-unsup", "DTSTART:20261102T090000Z", "SUMMARY:unsup", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"]),
	// DTSTART on a weekday the BYDAY filter excludes stays an instance via an extra.
	...vevent(["UID:f-anchor", "DTSTART:20261104T090000Z", "DTEND:20261104T093000Z", "SUMMARY:anchor", "RRULE:FREQ=WEEKLY;BYDAY=TU"]),
	// A cancelled detached occurrence excludes its instant.
	...vevent(["UID:f-cd", "DTSTART:20261102T090000Z", "SUMMARY:cd", "RRULE:FREQ=DAILY;COUNT=5"]),
	...vevent(["UID:f-cd", "RECURRENCE-ID:20261104T090000Z", "DTSTART:20261104T090000Z", "STATUS:CANCELLED"]),
	// An orphan detached occurrence imports standalone.
	...vevent(["UID:f-orph", "RECURRENCE-ID:20261109T090000Z", "DTSTART:20261109T120000Z", "DTEND:20261109T130000Z", "SUMMARY:orphan"]),
	// A custom zone resolves through the file's VTIMEZONE but recurs in UTC.
	"BEGIN:VTIMEZONE", "TZID:Custom/Zone", "BEGIN:STANDARD", "DTSTART:19670101T000000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "END:STANDARD", "END:VTIMEZONE",
	...vevent(["UID:f-cz", "DTSTART;TZID=Custom/Zone:20261102T090000", "DTEND;TZID=Custom/Zone:20261102T100000", "SUMMARY:custom zone", "RRULE:FREQ=DAILY;COUNT=3"]),
	"END:VCALENDAR");

test("a foreign file maps honestly onto the app model", async (t) => {
	const sqlite = await setup(t, { user: { id: "user-2", calendarEnabled: true, timeZone: "America/New_York" } });
	const res = await app.route.POST(req(googleFixture));
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.imported, 12);
	assert.equal(body.skipped, 0);
	const rows = Object.fromEntries(eventsOf(sqlite, "user-2").map((row) => [row.title, row]));

	// TZID resolves through Intl: 09:00 EST -> 14:00Z, and the zone name is stored.
	const google = rows["Google weekly"];
	assert.equal(google.repeat, "weekly");
	assert.equal(google.time_zone, "America/New_York");
	assert.equal(google.starts_at, sec("2026-11-04T14:00:00Z"));
	assert.equal(google.repeat_until, sec("2026-12-09T14:00:01Z")); // COUNT=6 -> sixth Wednesday + 1s.
	assert.deepEqual(JSON.parse(google.excluded_occurrences), [Date.parse("2026-11-11T14:00:00Z")]);
	const gOverrides = overridesOf(sqlite, google.id);
	assert.equal(gOverrides.length, 1);
	assert.equal(gOverrides[0].occurrence_ms, Date.parse("2026-11-18T14:00:00Z"));
	assert.equal(gOverrides[0].starts_at, sec("2026-11-18T16:00:00Z"));
	assert.equal(gOverrides[0].title, "Google weekly moved");

	assert.equal(rows["leap"].repeat, "yearly");
	assert.equal(rows["fifth"].repeat, "monthly");
	assert.equal(rows["fifth"].repeat_weekday, 1);
	assert.equal(rows["fifth"].repeat_week, -1);

	const detOverrides = overridesOf(sqlite, rows["det master"].id);
	assert.equal(detOverrides.length, 1);
	assert.equal(detOverrides[0].occurrence_ms, Date.parse("2026-11-05T09:00:00Z"));
	assert.equal(detOverrides[0].starts_at, sec("2026-11-05T15:00:00Z"));
	assert.equal(detOverrides[0].title, "det extra");
	assert.equal(detOverrides[0].description, "moved");

	// Floating reads in the user's zone (EST = UTC-5) and keeps it for recurrence.
	assert.equal(rows["floating"].starts_at, sec("2026-11-03T14:00:00Z"));
	assert.equal(rows["floating"].time_zone, "America/New_York");
	// All-day: midnight to midnight in the resolved zone.
	assert.equal(rows["all day"].starts_at, sec("2026-11-05T05:00:00Z"));
	assert.equal(rows["all day"].ends_at, sec("2026-11-06T05:00:00Z"));

	assert.equal(rows["alarmed"].reminder_minutes, 30);
	assert.equal(rows["unsup"].repeat, "none");
	assert.equal(rows["orphan"].repeat, "none");
	assert.equal(rows["orphan"].starts_at, sec("2026-11-09T12:00:00Z"));

	// The Tuesday-filtered series keeps its Wednesday DTSTART as an extra occurrence.
	const anchor = rows["anchor"];
	assert.equal(anchor.repeat, "weekdays");
	assert.equal(anchor.repeat_days, "[2]");
	const aOverrides = overridesOf(sqlite, anchor.id);
	assert.equal(aOverrides.length, 1);
	assert.equal(aOverrides[0].occurrence_ms, Date.parse("2026-11-04T09:00:00Z"));

	// The cancelled detached occurrence lands in excludedOccurrences.
	assert.deepEqual(JSON.parse(rows["cd"].excluded_occurrences), [Date.parse("2026-11-04T09:00:00Z")]);
	assert.equal(rows["cd"].repeat_until, sec("2026-11-06T09:00:01Z"));

	// The custom zone resolves instants through its VTIMEZONE (+03:00) and recurs in UTC.
	const custom = rows["custom zone"];
	assert.equal(custom.starts_at, sec("2026-11-02T06:00:00Z"));
	assert.equal(custom.time_zone, null);
	assert.equal(custom.repeat_until, sec("2026-11-04T06:00:01Z"));

	// The notes explain every dropped piece.
	assert.ok(body.errors.some((e) => e.includes("ACTION=EMAIL")));
	assert.ok(body.errors.some((e) => e.includes("not supported; imported as a single occurrence")));
	assert.ok(body.errors.some((e) => e.includes("VTIMEZONE")));
	assert.ok(body.errors.some((e) => e.includes("without its series")));
});

test("an export round-trips through import field-for-field", async (t) => {
	const sqlite = await setup(t);
	const download = await app.exportRoute.GET(new Request("http://localhost/api/export/calendar"));
	assert.equal(download.status, 200);
	const text = await download.text();

	globalThis.calImportUser = secondUser;
	const res = await app.route.POST(req(text));
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.skipped, 0);

	const expectedColor = app.normalizeCalendarColor(undefined);
	const originals = Object.fromEntries(eventsOf(sqlite, "user-1").map((row) => [row.title, row]));
	const imported = Object.fromEntries(eventsOf(sqlite, "user-2").map((row) => [row.title, row]));
	assert.deepEqual(Object.keys(imported).sort(), Object.keys(originals).sort());
	const lastWeek = (week) => (week === 5 ? -1 : week); // the app reads a fifth week as "last".
	for (const [title, want] of Object.entries(originals)) {
		const got = imported[title];
		for (const column of ["title", "description", "location", "repeat", "repeat_days", "repeat_anchor_day", "repeat_interval", "repeat_weekday", "repeat_until", "excluded_occurrences", "time_zone", "starts_at", "ends_at", "reminder_minutes"]) {
			assert.deepEqual(got[column], want[column], `${title}.${column}`);
		}
		assert.deepEqual(lastWeek(got.repeat_week), lastWeek(want.repeat_week), `${title}.repeat_week`);
		// COLOR is not exported, so the import lands on the app default.
		assert.equal(got.color, expectedColor, `${title}.color`);
		// The exported attendee list is the trimmed, valid subset of what was stored.
		const wantAttendees = JSON.parse(want.attendees).map((a) => a.trim()).filter((a) => /^[^\s<>",;:@]+@[^\s<>",;:@]+$/.test(a));
		assert.deepEqual(JSON.parse(got.attendees), wantAttendees, `${title}.attendees`);
		// Overrides match by occurrence; a text field the file restated compares against the
		// effective value (a null override field inherits the series value).
		const gotOverrides = overridesOf(sqlite, got.id);
		const wantOverrides = overridesOf(sqlite, want.id);
		assert.equal(gotOverrides.length, wantOverrides.length, `${title} overrides`);
		for (const [index, wantOverride] of wantOverrides.entries()) {
			const gotOverride = gotOverrides[index];
			assert.equal(gotOverride.occurrence_ms, wantOverride.occurrence_ms, `${title} override ${index} occurrence_ms`);
			assert.equal(gotOverride.starts_at, wantOverride.starts_at, `${title} override ${index} starts_at`);
			assert.equal(gotOverride.ends_at, wantOverride.ends_at, `${title} override ${index} ends_at`);
			for (const column of ["title", "description", "location"]) {
				assert.equal(gotOverride[column] ?? want[column], wantOverride[column] ?? want[column], `${title} override ${index} ${column}`);
			}
		}
	}
});

test("a revised file upserts the same event instead of duplicating or going stale", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const file = (moved, title = "Master") => ics([
		...vevent(["UID:series", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", `SUMMARY:${title}`, "RRULE:FREQ=WEEKLY"]),
		...vevent(["UID:series", "RECURRENCE-ID:20261109T090000Z", `DTSTART:${moved}T090000Z`, `DTEND:${moved}T100000Z`, "SUMMARY:Moved"]),
	]);
	assert.equal((await (await app.route.POST(req(file("20261109")))).json()).imported, 1);
	// An identical re-import writes nothing and says so.
	const same = await (await app.route.POST(req(file("20261109")))).json();
	assert.deepEqual([same.imported, same.updated, same.skipped], [0, 0, 1]);
	// A moved detached occurrence updates the stored override in place on the same event.
	const moved = await (await app.route.POST(req(file("20261110")))).json();
	assert.deepEqual([moved.imported, moved.updated], [0, 1]);
	const [event] = eventsOf(sqlite, "user-2");
	assert.equal(event.title, "Master");
	const [override] = overridesOf(sqlite, event.id);
	assert.equal(override.occurrence_ms, Date.parse("2026-11-09T09:00:00Z"));
	assert.equal(override.starts_at, sec("2026-11-10T09:00:00Z"));
	// A changed master field lands on the same row — the file is the newer snapshot, not a new series.
	const renamed = await (await app.route.POST(req(file("20261110", "Renamed")))).json();
	assert.deepEqual([renamed.imported, renamed.updated], [0, 1]);
	assert.equal(eventsOf(sqlite, "user-2").length, 1);
	assert.equal(eventsOf(sqlite, "user-2")[0].title, "Renamed");
	// An override the file no longer describes is user data: left alone, never deleted.
	const dropped = await (await app.route.POST(req(ics(vevent(["UID:series", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:Renamed", "RRULE:FREQ=WEEKLY"]))))).json();
	assert.equal(dropped.updated, 0);
	assert.equal(overridesOf(sqlite, event.id).length, 1);
});

test("zone resolution prefers Intl, then the file's VTIMEZONE, then the floating zone", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const lying = L(
		"BEGIN:VCALENDAR", "VERSION:2.0",
		// A VTIMEZONE that contradicts Intl: same TZID, a bogus +03:00 offset. Intl wins.
		"BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:19670101T000000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "END:STANDARD", "END:VTIMEZONE",
		...vevent(["UID:lie", "DTSTART;TZID=America/New_York:20261104T090000", "SUMMARY:trusted zone"]),
		// A TZID nothing resolves — not Intl, not the file — falls back to the floating zone.
		...vevent(["UID:nowhere", "DTSTART;TZID=Mars/Olympus:20261104T090000", "SUMMARY:lost zone"]),
		"END:VCALENDAR");
	const res = await app.route.POST(req(lying));
	assert.equal(res.status, 200);
	const body = await res.json();
	const rows = Object.fromEntries(eventsOf(sqlite, "user-2").map((row) => [row.title, row]));
	// 09:00 EST per Intl is 14:00Z; the lying VTIMEZONE would have made it 06:00Z.
	assert.equal(rows["trusted zone"].starts_at, sec("2026-11-04T14:00:00Z"));
	assert.equal(rows["trusted zone"].time_zone, "America/New_York");
	// The unknown zone reads in the user's zone (UTC here) and keeps it for recurrence.
	assert.equal(rows["lost zone"].starts_at, sec("2026-11-04T09:00:00Z"));
	assert.equal(rows["lost zone"].time_zone, "UTC");
	assert.ok(body.errors.some((e) => e.includes('unknown TZID "Mars/Olympus"')));
});

test("COUNT and UNTIL bound a series at their earliest honest instant", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const body = await (await app.route.POST(req(ics([
		// COUNT=1 produces exactly DTSTART, so the bound lands one second after it.
		...vevent(["UID:c1", "DTSTART:20261102T090000Z", "SUMMARY:count one", "RRULE:FREQ=DAILY;COUNT=1"]),
		// An EXDATE removes a counted occurrence without extending the series: COUNT is of rule
		// instances, so the bound stays the third day even though the second is excluded.
		...vevent(["UID:c-ex", "DTSTART:20261102T090000Z", "SUMMARY:count exdate", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE:20261103T090000Z"]),
		// An UNTIL earlier than the COUNT bound wins.
		...vevent(["UID:c-u", "DTSTART:20261102T090000Z", "SUMMARY:count until", "RRULE:FREQ=DAILY;COUNT=10;UNTIL=20261104T090000Z"]),
		// A local UNTIL resolves in the event zone across a DST edge: 09:00 on March 8 is EDT
		// (13:00Z) after the 2am spring-forward, not the EST reading of 14:00Z.
		...vevent(["UID:c-dst", "DTSTART;TZID=America/New_York:20260301T090000", "SUMMARY:dst until", "RRULE:FREQ=DAILY;UNTIL=20260308T090000"]),
		// The same edge in UTC form: the last occurrence's instant sits on the EDT side of the jump.
		...vevent(["UID:c-dstu", "DTSTART;TZID=America/New_York:20260301T090000", "SUMMARY:dst until utc", "RRULE:FREQ=DAILY;UNTIL=20260308T130000Z"]),
	])))).json();
	assert.equal(body.imported, 5);
	const rows = Object.fromEntries(eventsOf(sqlite, "user-2").map((row) => [row.title, row]));
	assert.equal(rows["count one"].repeat_until, sec("2026-11-02T09:00:01Z"));
	assert.equal(rows["count exdate"].repeat_until, sec("2026-11-04T09:00:01Z"));
	assert.deepEqual(JSON.parse(rows["count exdate"].excluded_occurrences), [Date.parse("2026-11-03T09:00:00Z")]);
	assert.equal(rows["count until"].repeat_until, sec("2026-11-04T09:00:01Z"));
	assert.equal(rows["dst until"].repeat_until, sec("2026-03-08T13:00:01Z"));
	assert.equal(rows["dst until utc"].repeat_until, sec("2026-03-08T13:00:01Z"));
});

test("an octet-stream body imports and damaged bytes fail cleanly", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	const octet = new Request("http://localhost/api/import/calendar", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: ics(vevent(["UID:bin", "DTSTART:20261103T170000Z", "SUMMARY:octet"])) });
	assert.equal((await app.route.POST(octet)).status, 200);
	assert.equal(eventsOf(sqlite, "user-2")[0].title, "octet");
	for (const damaged of [
		"\x00\x01\x02PNG\x89PNGgarbage\x00\xff", // binary, not iCalendar at all
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261103T170000Z\r\nSUMMA", // truncated mid-line
		"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261103T170", // truncated, unclosed components
	]) {
		const res = await app.route.POST(req(damaged));
		assert.equal(res.status, 400, JSON.stringify(damaged.slice(0, 30)));
		assert.equal((await res.json()).error, "INVALID_ICS");
	}
});

test("a write failure rolls back its whole event and reports what was applied", async (t) => {
	const sqlite = await setup(t, { user: secondUser });
	// Fail only the override insert at the second event's occurrence instant.
	sqlite.exec(`CREATE TRIGGER fail_override BEFORE INSERT ON calendar_event_overrides WHEN NEW.occurrence_ms = ${Date.parse("2026-11-09T09:00:00Z")} BEGIN SELECT RAISE(ABORT, 'forced override failure'); END;`);
	const res = await app.route.POST(req(ics([
		...vevent(["UID:first", "DTSTART:20261101T090000Z", "SUMMARY:First"]),
		...vevent(["UID:two", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:Series", "RRULE:FREQ=WEEKLY"]),
		...vevent(["UID:two", "RECURRENCE-ID:20261109T090000Z", "DTSTART:20261109T110000Z", "DTEND:20261109T120000Z", "SUMMARY:Moved"]),
		...vevent(["UID:three", "DTSTART:20261103T090000Z", "SUMMARY:Third"]),
	])));
	assert.equal(res.status, 500);
	const body = await res.json();
	assert.equal(body.error, "IMPORT_PARTIAL_FAILURE");
	assert.equal(body.imported, 1);
	assert.equal(body.failed, 1);
	assert.equal(body.reverted, true);
	assert.equal(body.unattempted, 1);
	// The aborted batch left no split state: the first event committed, the failed event left
	// zero rows — neither its master nor half its override set.
	assert.deepEqual(eventsOf(sqlite, "user-2").map((event) => event.title), ["First"]);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_event_overrides o JOIN calendar_events e ON o.event_id = e.id WHERE e.user_id = 'user-2'").get().n, 0);
	// The client gets the outcome, not the driver's message — raw SQL errors stay in the server log.
	assert.ok(!body.detail.includes("forced override failure"));
});

// env.DB fakes a Neon-class external driver: the drizzle handle is real, but its batch runs
// statements sequentially and the executor honestly reports no transaction — the shape
// lazyExecutor produces for HTTP protocols. Returns the handle to the raw sqlite for triggers.
async function sequentialDriver(t, seedSql) {
	const { sqlite, db } = await newDatabase(t, seedSql);
	globalThis.calImportUser = secondUser;
	globalThis.calImportKey = null;
	globalThis.calImportEnv = {
		DB: {
			createDrizzle: () => new Proxy(db, {
				get: (target, prop) => (prop === "batch"
					? async (statements) => {
						for (const statement of statements) await statement;
					}
					: Reflect.get(target, prop)),
			}),
			sqlExecutor: { dialect: "postgres", query: async () => { throw new Error("unreachable"); }, atomicBatch: async () => false },
		},
	};
	return sqlite;
}

test("on a driver without transactions a failed event is cleaned up and reported", async (t) => {
	const sqlite = await sequentialDriver(t, seed);
	const logged = [];
	const originalError = console.error;
	console.error = (...args) => logged.push(args);
	t.after(() => { console.error = originalError; });
	sqlite.exec(`CREATE TRIGGER fail_override BEFORE INSERT ON calendar_event_overrides WHEN NEW.occurrence_ms = ${Date.parse("2026-11-09T09:00:00Z")} BEGIN SELECT RAISE(ABORT, 'forced override failure'); END;`);
	const res = await app.route.POST(req(ics([
		...vevent(["UID:first", "DTSTART:20261101T090000Z", "SUMMARY:First"]),
		...vevent(["UID:two", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:Series", "RRULE:FREQ=WEEKLY"]),
		...vevent(["UID:two", "RECURRENCE-ID:20261109T090000Z", "DTSTART:20261109T110000Z", "DTEND:20261109T120000Z", "SUMMARY:Moved"]),
		...vevent(["UID:three", "DTSTART:20261103T090000Z", "SUMMARY:Third"]),
	])));
	assert.equal(res.status, 500);
	const body = await res.json();
	assert.equal(body.error, "IMPORT_PARTIAL_FAILURE");
	assert.equal(body.imported, 1);
	assert.equal(body.failed, 1);
	assert.equal(body.reverted, true);
	assert.equal(body.unattempted, 1);
	assert.ok(body.detail.includes("partial writes were removed"));
	// Sequential execution committed the failed event's master before the override aborted;
	// compensation removed it, so storage looks exactly like the transactional case.
	assert.deepEqual(eventsOf(sqlite, "user-2").map((event) => event.title), ["First"]);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_event_overrides o JOIN calendar_events e ON o.event_id = e.id WHERE e.user_id = 'user-2'").get().n, 0);
	// The raw driver error is a server-side diagnostic, not client detail.
	assert.ok(!body.detail.includes("forced override failure"));
	assert.ok(!body.detail.includes("insert into"));
	assert.ok(logged.some((args) => String(args[0]).includes("calendar import failed") && String(args[1]).includes("Failed query")));
});

test("when cleanup also fails the response admits partial rows may remain", async (t) => {
	const sqlite = await sequentialDriver(t, seed);
	sqlite.exec(`CREATE TRIGGER fail_override BEFORE INSERT ON calendar_event_overrides WHEN NEW.occurrence_ms = ${Date.parse("2026-11-09T09:00:00Z")} BEGIN SELECT RAISE(ABORT, 'forced override failure'); END;`);
	sqlite.exec("CREATE TRIGGER block_cleanup BEFORE DELETE ON calendar_events WHEN OLD.user_id = 'user-2' BEGIN SELECT RAISE(ABORT, 'delete blocked'); END;");
	const res = await app.route.POST(req(ics([
		...vevent(["UID:first", "DTSTART:20261101T090000Z", "SUMMARY:First"]),
		...vevent(["UID:two", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:Series", "RRULE:FREQ=WEEKLY"]),
		...vevent(["UID:two", "RECURRENCE-ID:20261109T090000Z", "DTSTART:20261109T110000Z", "DTEND:20261109T120000Z", "SUMMARY:Moved"]),
	])));
	assert.equal(res.status, 500);
	const body = await res.json();
	assert.equal(body.error, "IMPORT_PARTIAL_FAILURE");
	assert.equal(body.failed, 1);
	assert.equal(body.reverted, false);
	assert.ok(body.detail.includes("may remain"));
	// The failed event's master committed before the abort and the blocked cleanup left it: the
	// report counts it as failed, not applied, and never claims the store is clean.
	assert.deepEqual(eventsOf(sqlite, "user-2").map((event) => event.title), ["First", "Series"]);
});

test("the export feed for a fixed fixture still hashes to its pinned digest", async () => {
	// Pins F21's download byte-for-byte on this branch: a fixed clock, one TZID series with an
	// exclusion, an RSVP'd guest, a detached exception and an extra occurrence.
	const events = [{
		id: "evt-fixture", title: "Fixture sync", description: "desc", location: "Room",
		startsAt: new Date("2026-11-02T17:00:00Z"), endsAt: new Date("2026-11-02T17:30:00Z"),
		repeat: "weekly", repeatDays: "[]", repeatAnchorDay: null, repeatUntil: null, repeatInterval: 1,
		repeatWeekday: null, repeatWeek: null, excludedOccurrences: "[1763600400000]", timeZone: "America/New_York",
		attendees: '["guest@example.com"]', attendeeResponses: '{"guest@example.com":"accepted"}', reminderMinutes: 15,
		updatedAt: new Date("2026-11-01T00:00:00Z"), responseStatus: null,
	}];
	const overrides = new Map([["evt-fixture", [
		{ occurrenceMs: 1762995600000, startsAt: new Date("2026-11-12T22:00:00Z"), endsAt: new Date("2026-11-12T22:30:00Z"), title: "Moved", description: null, location: null },
		{ occurrenceMs: 1764190800000, startsAt: new Date("2026-11-26T19:00:00Z"), endsAt: new Date("2026-11-26T19:30:00Z"), title: null, description: null, location: null },
	]]]);
	const feed = app.buildCalendarFeed(events, { name: "Mailflare", now: new Date("2026-11-05T12:00:00Z"), download: true }, overrides);
	assert.equal(createHash("sha256").update(feed).digest("hex"), "1c1476acebcb173b34bcf7d74e3341543c5866c27587e842610e54066bf4ba87");
});
