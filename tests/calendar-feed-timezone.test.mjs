import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// Saving the account time zone backfills recurring rows with timeZone IS NULL to the previous
// zone so legacy series keep their instants. NULL is also the importer's marker for UTC input
// on feed-owned rows, so the backfill must skip subscriptionId rows — otherwise an unchanged
// feed's recurring events silently shift and a 304 refresh never repairs them.

const mocks = {
	"@/lib/cloudflare": `export function getEnv(){return globalThis.tzFeedEnv}`,
	"@/lib/auth/cookies": `export async function getCurrentUser(){return globalThis.tzFeedUser}`,
};
const { app, newDatabase } = await loadApp("tz-feed", `
	export * as timezone from "./src/app/api/settings/time-zone/route.ts";
	export { runCalendarTool } from "./src/lib/calendar/tools.ts";
	export { prepareCalendarImport } from "./src/lib/calendar/ics-import.ts";
	export { subscriptionIdScheme } from "./src/lib/calendar/subscriptions.ts";
	export { calendarEvents } from "./src/db/schema/index.ts";
`, { mocks });

const setup = async (t) => {
	const { env, sqlite } = await newDatabase(t, `
		INSERT INTO users (id, email, password_hash, name, role, created_at, time_zone) VALUES
			('user-1', 'u@example.com', 'hash', 'User', 'user', 1, 'America/New_York');
		INSERT INTO calendar_subscriptions (id, user_id, feed_url, title, created_at, updated_at) VALUES
			('sub_1', 'user-1', 'https://example.com/calendar.ics', 'Feed', 1, 1);
		INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at, "repeat") VALUES
			('evt_legacy', 'user-1', 'Legacy standup', 1796144400, 1796148000, 1, 1, 'weekly');
	`);
	Object.assign(env, { CF_TOKEN: "test-secret" });
	const user = { id: "user-1", calendarEnabled: true, timeZone: "America/New_York" };
	globalThis.tzFeedEnv = env;
	globalThis.tzFeedUser = user;
	return { env, sqlite, user };
};

const request = (body) => new Request("http://localhost/api/settings/time-zone", {
	method: "PATCH",
	headers: { "Content-Type": "application/json", Origin: "http://localhost" },
	body: JSON.stringify(body),
});

const zoneOf = (sqlite, id) => sqlite.prepare("SELECT time_zone FROM calendar_events WHERE id = ?").get(id).time_zone;

test("the backfill still freezes a personal legacy NULL-zone recurring row to the old zone", async (t) => {
	const { sqlite } = await setup(t);
	assert.equal(zoneOf(sqlite, "evt_legacy"), null);
	const response = await app.timezone.PATCH(request({ timeZone: "UTC" }));
	assert.equal(response.status, 200);
	assert.equal(zoneOf(sqlite, "evt_legacy"), "America/New_York");
});

test("a feed-owned NULL-zone recurring row stays NULL and its instances do not move", async (t) => {
	const { env, sqlite, user } = await setup(t);
	const feed = [
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN",
		"BEGIN:VEVENT", "UID:utc-test", "DTSTART:20260102T170000Z", "DTEND:20260102T180000Z",
		"SUMMARY:UTC feed event", "RRULE:FREQ=WEEKLY", "END:VEVENT", "END:VCALENDAR", "",
	].join("\r\n");
	const prepared = await app.prepareCalendarImport(feed, { userId: user.id, floatingZone: user.timeZone, idScheme: app.subscriptionIdScheme(user.id, "sub_1") });
	assert.equal(prepared.events.length, 1);
	const [event] = prepared.events;
	assert.equal(event.repeat, "weekly");
	assert.equal(event.timeZone, null);
	await app.getDb(env).insert(app.calendarEvents).values({ ...event, subscriptionId: "sub_1" });

	const query = () => app.runCalendarTool({ env, user }, "get_schedule", { start: "2026-07-02T00:00:00Z", end: "2026-07-05T00:00:00Z" });
	assert.equal((await query()).events[0].startsAt, "2026-07-03T17:00:00.000Z");
	const response = await app.timezone.PATCH(request({ timeZone: "UTC" }));
	assert.equal(response.status, 200);
	assert.equal(zoneOf(sqlite, event.id), null);
	assert.equal((await query()).events[0].startsAt, "2026-07-03T17:00:00.000Z");
});
