import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// External calendar subscriptions: POST /api/calendar/subscriptions fetches a webcal/https feed
// through the SSRF guard and imports it; the five-minute cron refreshes due feeds with a
// conditional GET; DELETE unsubscribes and cascades the feed's evt_s_ events and overrides.
const mocks = {
	"@/lib/cloudflare": `export function getEnv(){return globalThis.calSubEnv}`,
	"@/lib/auth/cookies": `export async function getCurrentUser(){return globalThis.calSubUser}`,
	"@/lib/api/key-auth": `export async function authenticateApiRequest(){return globalThis.calSubKey} export async function authenticateApiKeyValue(){return null} export function hasScope(scopes,required){return scopes.includes(required)||scopes.includes("*")}`,
};
const { app, newDatabase } = await loadApp("cal-subs", `
	export * as route from "./src/app/api/calendar/subscriptions/route.ts";
	export * as itemRoute from "./src/app/api/calendar/subscriptions/[subscriptionId]/route.ts";
	export { runCalendarSubscriptionRefresh, refreshSubscription, subscriptionIdScheme, subscriptionDue } from "./src/lib/calendar/subscriptions.ts";
	export { normalizeFeedUrl, fetchCalendarFeed, FeedFetchError } from "./src/lib/calendar/subscription-feed.ts";
	export { calendarSubscriptions } from "./src/db/schema/index.ts";
`, { mocks });

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('user-1', 'u@example.com', 'hash', 'User', 'user', 1),
		('user-2', 'v@example.com', 'hash', 'Empty', 'user', 1),
		('user-off', 'off@example.com', 'hash', 'Off', 'user', 1);
	UPDATE users SET calendar_enabled = 0 WHERE id = 'user-off';
`;

const sessionUser = { id: "user-1", calendarEnabled: true, timeZone: "UTC" };
const secondUser = { id: "user-2", calendarEnabled: true, timeZone: "UTC" };
const keyWith = (scopes, user = sessionUser) => ({ keyId: "k1", userId: user.id, scopes, mailboxIds: null, user });

async function setup(t, { user = sessionUser, key = null, seedSql = seed } = {}) {
	const { env, sqlite } = await newDatabase(t, seedSql);
	globalThis.calSubEnv = env;
	globalThis.calSubUser = user;
	globalThis.calSubKey = key;
	return { env, sqlite };
}

const ics = (lines) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${lines.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const vevent = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

const feedV1 = ics([
	"X-WR-CALNAME:Release Calendar",
	...vevent(["UID:evt-a", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Release party"]),
	...vevent(["UID:evt-b", "DTSTART:20261202T170000Z", "DTEND:20261202T180000Z", "SUMMARY:Standup", "RRULE:FREQ=DAILY;COUNT=3"]),
]);
const feedV2 = ics([
	"X-WR-CALNAME:Release Calendar",
	...vevent(["UID:evt-a", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Release party moved"]),
	...vevent(["UID:evt-c", "DTSTART:20261205T170000Z", "DTEND:20261205T180000Z", "SUMMARY:New review"]),
]);

const PUBLIC_IP = "93.184.216.34";

/**
 * Stubs globalThis.fetch: DNS-over-HTTPS lookups answer with `resolve(name)` (default one public
 * address) and everything else goes to `serve(url, init)` — the fake feed server.
 */
function stubFetch(t, { serve, resolve } = {}) {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		if (url.hostname === "cloudflare-dns.com") {
			const name = url.searchParams.get("name");
			const type = url.searchParams.get("type");
			const data = resolve ? resolve(name) : PUBLIC_IP;
			if (data === null) return Response.json({ Status: 0, Answer: [] });
			return Response.json({ Status: 0, Answer: type === "A" ? [{ name, type: 1, TTL: 60, data }] : [] });
		}
		calls.push({ url, init });
		return serve(url, init);
	});
	return calls;
}

const feedResponse = (body, headers = {}) => new Response(body, { status: 200, headers: { "content-type": "text/calendar", ...headers } });
const post = (body) => new Request("http://localhost/api/calendar/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (id, body) => new Request(`http://localhost/api/calendar/subscriptions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const del = (id) => new Request(`http://localhost/api/calendar/subscriptions/${id}`, { method: "DELETE" });
const params = (subscriptionId) => ({ params: Promise.resolve({ subscriptionId }) });

const subsOf = (sqlite, userId) => sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE user_id = ?").all(userId);
const eventsOf = (sqlite, subId) => sqlite.prepare("SELECT * FROM calendar_events WHERE subscription_id = ? ORDER BY title").all(subId);
const overridesOf = (sqlite, eventId) => sqlite.prepare("SELECT * FROM calendar_event_overrides WHERE event_id = ? ORDER BY occurrence_ms").all(eventId);

test("subscribing to a webcal feed imports its events as evt_s_ rows owned by the subscription", async (t) => {
	const { sqlite } = await setup(t);
	const calls = stubFetch(t, { serve: () => feedResponse(feedV1, { etag: '"v1"' }) });
	const res = await app.route.POST(post({ url: "webcal://feeds.example/release.ics" }));
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.added, 2);
	assert.equal(body.subscription.feedUrl, "https://feeds.example/release.ics");
	assert.equal(body.subscription.title, "Release Calendar");
	assert.equal(body.subscription.eventCount, 2);
	assert.equal(body.subscription.etag, '"v1"');
	const events = eventsOf(sqlite, body.subscription.id);
	assert.equal(events.length, 2);
	for (const event of events) {
		assert.ok(event.id.startsWith("evt_s_"), `id ${event.id}`);
		assert.equal(event.user_id, "user-1");
		assert.equal(event.subscription_id, body.subscription.id);
	}
	assert.equal(events.find((event) => event.title === "Release party").starts_at, sec("2026-12-01T17:00:00Z"));
	// The fetch went out guarded: manual redirects, no credentials.
	assert.equal(calls.length, 1);
	assert.equal(calls[0].init.redirect, "manual");
});

test("GET lists the user's subscriptions and a read-scoped key can use it", async (t) => {
	await setup(t, { user: null, key: keyWith(["calendar:read"]) });
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	globalThis.calSubKey = keyWith(["calendar:write"]);
	await app.route.POST(new Request("http://localhost/api/calendar/subscriptions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ep_k" }, body: JSON.stringify({ url: "https://feeds.example/release.ics" }) }));
	globalThis.calSubKey = keyWith(["calendar:read"]);
	const res = await app.route.GET(new Request("http://localhost/api/calendar/subscriptions", { headers: { authorization: "Bearer ep_k" } }));
	assert.equal(res.status, 200);
	const { subscriptions } = await res.json();
	assert.equal(subscriptions.length, 1);
	assert.equal(subscriptions[0].feedUrl, "https://feeds.example/release.ics");
});

test("a write key cannot list and a read key cannot subscribe", async (t) => {
	await setup(t, { user: null, key: keyWith(["calendar:write"]) });
	assert.equal((await app.route.GET(new Request("http://localhost/api/calendar/subscriptions", { headers: { authorization: "Bearer ep_k" } }))).status, 403);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	globalThis.calSubKey = keyWith(["calendar:read"]);
	const res = await app.route.POST(new Request("http://localhost/api/calendar/subscriptions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ep_k" }, body: JSON.stringify({ url: "https://feeds.example/release.ics" }) }));
	assert.equal(res.status, 403);
});

test("no session and no key is a 401", async (t) => {
	await setup(t, { user: null });
	assert.equal((await app.route.GET(new Request("http://localhost/api/calendar/subscriptions"))).status, 401);
	assert.equal((await app.route.POST(post({ url: "https://feeds.example/x.ics" }))).status, 401);
});

test("a disabled calendar blocks both session and key access", async (t) => {
	const off = { id: "user-off", calendarEnabled: false, timeZone: "UTC" };
	await setup(t, { user: off });
	assert.equal((await app.route.POST(post({ url: "https://feeds.example/x.ics" }))).status, 403);
});

test("the same feed cannot be subscribed twice, even via webcal and https spellings", async (t) => {
	await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	assert.equal((await app.route.POST(post({ url: "webcal://feeds.example/release.ics" }))).status, 200);
	const res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 409);
});

test("private and internal URLs are refused before any fetch", async (t) => {
	await setup(t);
	const calls = stubFetch(t, { serve: () => feedResponse(feedV1) });
	for (const url of [
		"http://127.0.0.1/feed.ics",
		"https://[::1]/feed.ics",
		"https://10.0.0.4/feed.ics",
		"https://192.168.1.1/feed.ics",
		"https://169.254.169.254/latest/meta-data",
		"http://localhost/feed.ics",
		"https://calendar.internal/feed.ics",
		"https://127.0.0.1.nip.io/feed.ics",
		"ftp://feeds.example/x.ics",
		"https://user:pw@feeds.example/x.ics",
	]) {
		const res = await app.route.POST(post({ url }));
		assert.equal(res.status, 400, url);
	}
	assert.equal(calls.length, 0, "no outbound fetch may happen");
});

test("a public hostname that resolves to a private address is refused after resolution", async (t) => {
	await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1), resolve: () => "10.1.2.3" });
	const res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "Calendar feed must point at a public host");
});

test("a redirect to a privately-resolving host is refused at the second hop", async (t) => {
	await setup(t);
	let hops = 0;
	stubFetch(t, {
		resolve: (name) => (name === "internal-elsewhere.example" ? "10.9.9.9" : PUBLIC_IP),
		serve: (url) => {
			hops += 1;
			if (url.hostname === "feeds.example") return new Response(null, { status: 302, headers: { location: "https://internal-elsewhere.example/feed.ics" } });
			return feedResponse(feedV1);
		},
	});
	const res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 400);
	assert.equal(hops, 1, "the redirect target was blocked before it was fetched");
});

test("https feeds may not redirect back down to http", async (t) => {
	await setup(t);
	stubFetch(t, {
		serve: (url) => {
			if (url.protocol === "http:") return feedResponse(feedV1);
			return new Response(null, { status: 302, headers: { location: "http://feeds.example/release.ics" } });
		},
	});
	const res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 502);
	assert.match((await res.json()).detail, /https/);
});

test("an https upgrade redirect is followed", async (t) => {
	const { sqlite } = await setup(t);
	stubFetch(t, {
		serve: (url) => (url.protocol === "http:" ? new Response(null, { status: 301, headers: { location: "https://feeds.example/release.ics" } }) : feedResponse(feedV1)),
	});
	const res = await app.route.POST(post({ url: "http://feeds.example/release.ics" }));
	assert.equal(res.status, 200);
	assert.equal(subsOf(sqlite, "user-1").length, 1);
});

test("unreachable, error-status, non-ics and oversized feeds fail cleanly", async (t) => {
	await setup(t);
	let mode = "down";
	stubFetch(t, {
		serve: () => {
			if (mode === "down") throw new TypeError("connect ECONNREFUSED");
			if (mode === "500") return new Response("oops", { status: 500 });
			if (mode === "html") return new Response("<html><body>not a calendar</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			if (mode === "huge") return new Response("x", { status: 200, headers: { "content-type": "text/calendar", "content-length": String(3 * 1024 * 1024) } });
			return feedResponse(feedV1);
		},
	});
	mode = "down";
	let res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 502);
	assert.equal((await res.json()).error, "FEED_FETCH_FAILED");
	mode = "500";
	res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 502);
	assert.match((await res.json()).detail, /500/);
	mode = "html";
	res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "INVALID_ICS");
	mode = "huge";
	res = await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	assert.equal(res.status, 413);
	assert.equal((await res.json()).error, "FEED_LIMIT_EXCEEDED");
});

test("the cron refresh sends the stored validators and a 304 only moves lastRefreshAt", async (t) => {
	const { env, sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1, { etag: '"v1"', "last-modified": "Mon, 01 Dec 2026 00:00:00 GMT" }) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	const titleBefore = sqlite.prepare("SELECT title FROM calendar_events WHERE subscription_id = ?").all(subId);
	// Wind the subscription back so it is due again, then answer the conditional GET with a 304.
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1 WHERE id = ?").run(subId);
	stubFetch(t, {
		serve: (url, init) => {
			assert.equal(new Headers(init.headers).get("if-none-match"), '"v1"');
			assert.equal(new Headers(init.headers).get("if-modified-since"), "Mon, 01 Dec 2026 00:00:00 GMT");
			return new Response(null, { status: 304 });
		},
	});
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	const sub = sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE id = ?").get(subId);
	assert.equal(sub.last_refresh_status, 304);
	assert.equal(sub.last_refresh_at, sec("2026-11-24T12:00:00Z"));
	assert.equal(sub.last_error, null);
	assert.deepEqual(sqlite.prepare("SELECT title FROM calendar_events WHERE subscription_id = ?").all(subId), titleBefore);
});

test("a changed feed updates moved events, adds new ones and prunes vanished ones", async (t) => {
	const { env, sqlite } = await setup(t);
	let body = feedV1;
	stubFetch(t, { serve: () => feedResponse(body, { etag: '"v1"' }) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	// A user-created event sharing a feed UID must survive: evt_s_ and evt_ never touch.
	sqlite.prepare("INSERT INTO calendar_events (id, user_id, title, repeat, repeat_days, excluded_occurrences, starts_at, ends_at, created_at, updated_at) VALUES ('evt_manual', 'user-1', 'Standup (mine)', 'none', '[]', '[]', ?, ?, 1, 1)").run(sec("2026-12-02T17:00:00Z"), sec("2026-12-02T18:00:00Z"));
	// Wind the subscription back so it is due again, then serve the changed feed.
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = ? WHERE id = ?").run(1, subId);
	body = feedV2;
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	const sub = sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE id = ?").get(subId);
	assert.equal(sub.last_refresh_status, 200);
	assert.equal(sub.event_count, 2);
	const events = eventsOf(sqlite, subId);
	assert.deepEqual(events.map((event) => event.title), ["New review", "Release party moved"]);
	assert.equal(sqlite.prepare("SELECT title FROM calendar_events WHERE id = 'evt_manual'").get().title, "Standup (mine)");
});

test("recurrence-id feed rows land as overrides and disappear with them", async (t) => {
	const { env, sqlite } = await setup(t);
	const withException = ics([
		...vevent(["UID:weekly", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Weekly", "RRULE:FREQ=WEEKLY;COUNT=4"]),
		...vevent(["UID:weekly", "RECURRENCE-ID:20261208T170000Z", "DTSTART:20261208T190000Z", "DTEND:20261208T200000Z", "SUMMARY:Weekly moved"]),
	]);
	const withoutException = ics([
		...vevent(["UID:weekly", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Weekly", "RRULE:FREQ=WEEKLY;COUNT=4"]),
	]);
	let body = withException;
	stubFetch(t, { serve: () => feedResponse(body) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/w.ics" }))).json();
	const subId = created.subscription.id;
	const [event] = eventsOf(sqlite, subId);
	assert.equal(overridesOf(sqlite, event.id).length, 1);
	assert.equal(overridesOf(sqlite, event.id)[0].starts_at, sec("2026-12-08T19:00:00Z"));
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1 WHERE id = ?").run(subId);
	body = withoutException;
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	assert.equal(overridesOf(sqlite, event.id).length, 0, "the feed owns its overrides wholesale");
});

test("the cron skips feeds whose interval has not elapsed and disabled users' feeds", async (t) => {
	const { env, sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	// This subscription refreshed seconds ago; its 3600s interval is nowhere near due.
	const calls = stubFetch(t, { serve: () => feedResponse(feedV2) });
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	assert.equal(calls.length, 0);
	// A disabled user's due feed is not fetched either.
	sqlite.prepare("INSERT INTO calendar_subscriptions (id, user_id, feed_url, title, refresh_interval_sec, last_refresh_at, event_count, created_at, updated_at) VALUES ('sub-off', 'user-off', 'https://feeds.example/off.ics', 'Off', 300, 1, 0, 1, 1)").run();
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	assert.equal(calls.length, 0);
});

test("a failed refresh records the error on the row and does not crash the run", async (t) => {
	const { env, sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	await app.route.POST(post({ url: "https://feeds.example/release.ics" }));
	await app.route.POST(post({ url: "https://feeds.example/second.ics" }));
	// One feed 500s, the other stays healthy; both are due.
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1").run();
	stubFetch(t, {
		serve: (url) => (url.pathname.includes("release.ics") ? new Response("down", { status: 500 }) : feedResponse(feedV2)),
	});
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	const broken = sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE feed_url LIKE '%release%'").get();
	const healthy = sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE feed_url LIKE '%second%'").get();
	assert.equal(broken.last_refresh_status, 500);
	assert.match(broken.last_error, /500/);
	// Its events stay put: a transient upstream failure never wipes the calendar.
	assert.equal(eventsOf(sqlite, broken.id).length, 2);
	assert.equal(healthy.last_refresh_status, 200);
	assert.equal(healthy.last_error, null);
});

test("PATCH renames and re-intervals a subscription, scoped to the owner", async (t) => {
	const { sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	const res = await app.itemRoute.PATCH(patch(subId, { title: "My releases", refreshIntervalSec: 7200 }), params(subId));
	assert.equal(res.status, 200);
	const { subscription } = await res.json();
	assert.equal(subscription.title, "My releases");
	assert.equal(subscription.refreshIntervalSec, 7200);
	assert.equal((await app.itemRoute.PATCH(patch(subId, { refreshIntervalSec: 60 }), params(subId))).status, 400);
	assert.equal((await app.itemRoute.PATCH(patch(subId, {}), params(subId))).status, 400);
	assert.equal((await app.itemRoute.PATCH(patch("sub-nope", { title: "x" }), params("sub-nope"))).status, 404);
	// Another user's subscription cannot be patched.
	globalThis.calSubUser = secondUser;
	assert.equal((await app.itemRoute.PATCH(patch(subId, { title: "stolen" }), params(subId))).status, 404);
	assert.equal(sqlite.prepare("SELECT title FROM calendar_subscriptions WHERE id = ?").get(subId).title, "My releases");
});

test("DELETE unsubscribes and cascades the feed's events and overrides", async (t) => {
	const { sqlite } = await setup(t);
	const withException = ics([
		...vevent(["UID:weekly", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Weekly", "RRULE:FREQ=WEEKLY;COUNT=4"]),
		...vevent(["UID:weekly", "RECURRENCE-ID:20261208T170000Z", "DTSTART:20261208T190000Z", "DTEND:20261208T200000Z", "SUMMARY:Weekly moved"]),
		...vevent(["UID:solo", "DTSTART:20261210T170000Z", "DTEND:20261210T180000Z", "SUMMARY:Solo"]),
	]);
	stubFetch(t, { serve: () => feedResponse(withException) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/w.ics" }))).json();
	const subId = created.subscription.id;
	assert.equal(eventsOf(sqlite, subId).length, 2);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_event_overrides").get().n, 1);
	const res = await app.itemRoute.DELETE(del(subId), params(subId));
	assert.equal(res.status, 200);
	assert.equal(subsOf(sqlite, "user-1").length, 0);
	assert.equal(eventsOf(sqlite, subId).length, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_event_overrides").get().n, 0);
	assert.equal((await app.itemRoute.DELETE(del(subId), params(subId))).status, 404);
});

test("the evt_s_ identity folds in the subscription id, so two feeds can carry the same UID", async (t) => {
	const { sqlite } = await setup(t);
	const sameUid = ics(vevent(["UID:shared", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Shared"]));
	stubFetch(t, { serve: () => feedResponse(sameUid) });
	const first = await (await app.route.POST(post({ url: "https://feeds.example/a.ics" }))).json();
	const second = await (await app.route.POST(post({ url: "https://feeds.example/b.ics" }))).json();
	const firstEvents = eventsOf(sqlite, first.subscription.id);
	const secondEvents = eventsOf(sqlite, second.subscription.id);
	assert.equal(firstEvents.length, 1);
	assert.equal(secondEvents.length, 1);
	assert.notEqual(firstEvents[0].id, secondEvents[0].id, "same UID, different feeds, different rows");
});

test("every fetch hop pins the connection to the addresses the DNS check approved", async (t) => {
	await setup(t);
	const resolutions = [];
	const pins = [];
	const requests = [];
	let closed = false;
	const result = await app.fetchCalendarFeed("https://feeds.example/release.ics", {
		resolveHost: async (hostname) => {
			// A hostile resolver that would answer differently on a second lookup: the pinned set
			// must be exactly what this call returned, because there is no second call to exploit.
			resolutions.push(hostname);
			return [PUBLIC_IP];
		},
		pinConnection: async (hostname, addresses) => {
			pins.push({ hostname, addresses });
			return { dispatcher: { close: async () => { closed = true; } } };
		},
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return feedResponse(feedV1);
		},
	});
	assert.equal(result.outcome, "fetched");
	assert.deepEqual(resolutions, ["feeds.example"], "one resolution per hop");
	assert.equal(pins.length, 1);
	assert.deepEqual(pins[0].addresses, [PUBLIC_IP], "the pin is the validated address set");
	assert.equal(requests[0].init.dispatcher.close !== undefined, true, "the request goes out on the pinned dispatcher");
	assert.equal(requests[0].init.cf, undefined, "no fabricated cf option is emitted");
	assert.equal(new URL(requests[0].url).hostname, "feeds.example", "the URL keeps its hostname for Host/SNI");
	assert.equal(requests[0].init.redirect, "manual");
	assert.equal(closed, true, "the per-hop dispatcher is closed after the hop");

	// On this Node runtime the default pin is a per-request undici dispatcher carrying the lookup.
	const defaultCalls = stubFetch(t, { serve: () => feedResponse(feedV1) });
	const defaultResult = await app.fetchCalendarFeed("https://feeds.example/release.ics");
	assert.equal(defaultResult.outcome, "fetched");
	assert.ok(defaultCalls[0].init.dispatcher, "the default pin supplies a dispatcher");
	assert.equal(defaultCalls[0].init.cf, undefined);

	// A runtime with no pinning facility must fail closed, not fall back to an unpinned request.
	const closedCalls = stubFetch(t, { serve: () => feedResponse(feedV1) });
	await assert.rejects(
		app.fetchCalendarFeed("https://feeds.example/release.ics", { pinConnection: async () => ({}) }),
		(error) => error instanceof app.FeedFetchError && error.code === "pinning_unavailable",
	);
	assert.equal(closedCalls.length, 0, "nothing was fetched unpinned");
});

// Workers-family runtimes (navigator.userAgent "Cloudflare-Workers") have no per-request socket
// pin: cf.resolveOverride only honors same-zone proxied hostnames and startTls hostname
// verification is inert on the edge (workerd#6903). The fetch instead relies on the platform's
// public-only egress plus TLS hostname verification — but only when the deployment positively
// asserts hosted egress (MAILFLARE_RUNTIME=cloudflare); anything else fails closed.
const asWorkersRuntime = (t) => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
	t.after(() => {
		if (original) Object.defineProperty(globalThis, "navigator", original);
	});
};

test("on asserted hosted Workers the platform egress carries the guard, still validating every hop", async (t) => {
	await setup(t);
	asWorkersRuntime(t);
	const resolved = [];
	const calls = stubFetch(t, {
		resolve: (name) => {
			resolved.push(name);
			return PUBLIC_IP;
		},
		serve: (url) => (url.pathname === "/a.ics" ? new Response(null, { status: 302, headers: { location: "https://other.example/b.ics" } }) : feedResponse(feedV1)),
	});
	const result = await app.fetchCalendarFeed("https://feeds.example/a.ics", { publicEgressAsserted: true });
	assert.equal(result.outcome, "fetched");
	// Each hop resolves A and AAAA, so a hostname appears once per record type — dedupe to hops.
	assert.deepEqual([...new Set(resolved)], ["feeds.example", "other.example"], "DoH validation still runs per hop on Workers");
	for (const call of calls) {
		assert.equal(call.init.cf, undefined, "no fabricated cf option is emitted");
		assert.equal(call.init.dispatcher, undefined, "no socket pin exists on Workers — platform egress carries it");
	}

	// A private-range answer still rejects on the asserted runtime — the DoH check is the
	// defense-in-depth layer and must not be skipped just because the platform also filters.
	const privateCalls = stubFetch(t, {
		resolve: () => "10.0.0.1",
		serve: () => feedResponse(feedV1),
	});
	await assert.rejects(
		app.fetchCalendarFeed("https://feeds.example/release.ics", { publicEgressAsserted: true }),
		(error) => error instanceof app.FeedFetchError && error.code === "not_public",
	);
	assert.equal(privateCalls.length, 0);
});

test("a Workers runtime that cannot assert hosted public egress fails closed", async (t) => {
	await setup(t);
	asWorkersRuntime(t);
	const calls = stubFetch(t, { serve: () => feedResponse(feedV1) });
	await assert.rejects(
		app.fetchCalendarFeed("https://feeds.example/release.ics"),
		(error) => error instanceof app.FeedFetchError && error.code === "pinning_unavailable",
	);
	assert.equal(calls.length, 0, "nothing was fetched unpinned on an unasserted Workers runtime");
});

test("a cancelled-only snapshot keeps the stored events and records the anomaly", async (t) => {
	const { env, sqlite } = await setup(t);
	let body = feedV1;
	stubFetch(t, { serve: () => feedResponse(body) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	assert.equal(eventsOf(sqlite, subId).length, 2);
	// The upstream still answers 200, but every VEVENT is cancelled — a degraded snapshot must
	// not prune the calendar it owns.
	body = ics([
		"X-WR-CALNAME:Release Calendar",
		...vevent(["UID:evt-a", "STATUS:CANCELLED", "DTSTART:20261201T170000Z", "DTEND:20261201T180000Z", "SUMMARY:Release party"]),
		...vevent(["UID:evt-b", "STATUS:CANCELLED", "DTSTART:20261202T170000Z", "DTEND:20261202T180000Z", "SUMMARY:Standup", "RRULE:FREQ=DAILY;COUNT=3"]),
	]);
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1 WHERE id = ?").run(subId);
	await app.runCalendarSubscriptionRefresh(env, new Date("2026-11-24T12:00:00Z"));
	const sub = sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE id = ?").get(subId);
	assert.equal(sub.last_refresh_status, 200);
	assert.match(sub.last_error, /no usable events/i);
	assert.equal(eventsOf(sqlite, subId).length, 2, "the previous event set survived the anomalous snapshot");
	assert.equal(sub.event_count, 2);
	// The run logs the anomaly instead of reporting a healthy sync.
	const subRow = await dbSelect(env, subId);
	const outcome = await app.refreshSubscription(env, subRow, { fetch: async () => feedResponse(body), now: new Date("2026-11-24T13:00:00Z") });
	assert.equal(outcome.outcome, "anomaly");
	assert.equal(outcome.owned, 2);
});

test("a second refresh of the same feed loses the claim and writes nothing", async (t) => {
	const { env, sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1 WHERE id = ?").run(subId);
	const sub = await dbSelect(env, subId);
	// Two overlapping refreshes read the same row: only the first compare-and-set may proceed.
	const [first, second] = await Promise.all([
		app.refreshSubscription(env, sub, { fetch: async () => feedResponse(feedV2), now: new Date("2026-11-24T12:00:00Z") }),
		app.refreshSubscription(env, sub, { fetch: async () => feedResponse(feedV2), now: new Date("2026-11-24T12:00:00Z") }),
	]);
	const outcomes = [first.outcome, second.outcome].sort();
	assert.deepEqual(outcomes, ["skipped", "synced"], "exactly one refresh claimed the feed");
	assert.equal(eventsOf(sqlite, subId).length, 2);
	assert.deepEqual(eventsOf(sqlite, subId).map((event) => event.title).sort(), ["New review", "Release party moved"]);
});

test("unsubscribing mid-refresh leaves no zombie evt_s_ rows", async (t) => {
	const { env, sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1 WHERE id = ?").run(subId);
	const sub = await dbSelect(env, subId);
	// The claim wins, then the row is deleted while the fetch is in flight: the write phase must
	// see the missing owner and stop, so no evt_s_ row lands under a dead subscription id.
	const outcome = await app.refreshSubscription(env, sub, {
		fetch: async () => {
			sqlite.prepare("DELETE FROM calendar_subscriptions WHERE id = ?").run(subId);
			return feedResponse(feedV2);
		},
		now: new Date("2026-11-24T12:00:00Z"),
	});
	assert.equal(outcome.outcome, "unsubscribed");
	assert.equal(eventsOf(sqlite, subId).length, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE id LIKE 'evt_s_%'").get().n, 0, "no orphaned feed rows remain");
});

test("a failed event write reports the sync honestly and keeps prior rows", async (t) => {
	const { env, sqlite } = await setup(t);
	stubFetch(t, { serve: () => feedResponse(feedV1) });
	const created = await (await app.route.POST(post({ url: "https://feeds.example/release.ics" }))).json();
	const subId = created.subscription.id;
	// Refuse new event inserts mid-refresh: the stats must not credit writes that never landed.
	sqlite.exec("CREATE TRIGGER block_event_inserts BEFORE INSERT ON calendar_events BEGIN SELECT RAISE(ABORT, 'blocked insert'); END;");
	sqlite.prepare("UPDATE calendar_subscriptions SET last_refresh_at = 1 WHERE id = ?").run(subId);
	const sub = await dbSelect(env, subId);
	const outcome = await app.refreshSubscription(env, sub, { fetch: async () => feedResponse(feedV2), now: new Date("2026-11-24T12:00:00Z") });
	assert.equal(outcome.outcome, "failed");
	const row = sqlite.prepare("SELECT * FROM calendar_subscriptions WHERE id = ?").get(subId);
	assert.match(row.last_error, /failed/i);
	// evt-a's update already proved, evt-b was honestly pruned, evt-c's insert was refused — the
	// residue is exactly what the driver proved, and event_count is left at its last proven value.
	const titles = eventsOf(sqlite, subId).map((event) => event.title).sort();
	assert.deepEqual(titles, ["Release party moved"]);
	assert.equal(row.event_count, 2);
	sqlite.exec("DROP TRIGGER block_event_inserts");
});

async function dbSelect(env, subId) {
	const rows = await app.getDb(env).select().from(app.calendarSubscriptions);
	return rows.find((row) => row.id === subId);
}
