import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-promotions-intake-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
		`,
		resolveDir: root,
		sourcefile: "promotions-intake-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

function mime(from, extraHeaders = "", body = "hi there") {
	return `From: ${from}\r\nTo: me@one.test\r\nSubject: Hello\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@x.test>\r\nDate: Thu, 19 Nov 2026 10:00:00 +0000\r\n${extraHeaders}Content-Type: text/plain\r\n\r\n${body}\r\n`;
}

async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
	`);
	const objects = new Map();
	let bucketPut = async () => {};
	const env = {
		DB: database,
		MAILFLARE_RUNTIME: "node",
		BUCKET: { get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null), put: async (...args) => bucketPut(...args), delete: async (key) => { objects.delete(key); } },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	let n = 0;
	const storeRaw = async (raw) => {
		const key = `raw/${++n}`;
		objects.set(key, new TextEncoder().encode(raw).buffer);
		return key;
	};
	const deliverRaw = async (raw, payloadHeaders) => {
		const key = await storeRaw(raw);
		await m.processInboundMessage(env, { from: "bounce@x.test", to: "me@one.test", rawR2Key: key, headers: payloadHeaders });
		return key;
	};
	const deliver = async (from, headers = "", payloadHeaders, body) => {
		const key = await deliverRaw(mime(from, headers, body), payloadHeaders);
		return database.db.prepare("SELECT category, sender_address FROM messages WHERE raw_r2_key = ?").get(key);
	};
	// Realtime hub stand-in: every body POSTed to a user's hub, in order.
	const sent = [];
	env.REALTIME = { getByName: (user) => ({ fetch: async (_url, init) => { sent.push({ user, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); } }) };
	return { deliver, deliverRaw, storeRaw, raw: database.db, database, env, sent, setBucketPut: put => { bucketPut = put; } };
}

test("intake stores the category and sender address of bulk mail", async (t) => {
	const { deliver } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	assert.deepEqual(await deliver("News <News@Acme.com>", "List-Unsubscribe: <https://acme.com/u>\r\n"), { category: "promotions", sender_address: "news@acme.com" });
	assert.deepEqual(await deliver("Friend <friend@x.test>"), { category: null, sender_address: "friend@x.test" });
});

test("an ESP receipt with a footer unsubscribe link and no list headers stays in Inbox", async (t) => {
	const { deliver, raw } = await fixture(t);
	const receipt = await deliver("Shop <orders@shop.test>", "X-SES-Outgoing: 2026.11.19-1.2.3.4\r\nX-SG-EID: abc\r\n", undefined, "Your receipt. Unsubscribe: https://shop.test/unsubscribe?u=1");
	assert.equal(receipt.category, null);
	assert.equal(raw.prepare("SELECT has_unsubscribe FROM messages WHERE sender_address = 'orders@shop.test'").get().has_unsubscribe, 1);
});

test("intake reads headers from the raw message when the payload has none, and honours payload headers when present", async (t) => {
	const { deliver } = await fixture(t);
	assert.equal((await deliver("a@acme.com", "Precedence: bulk\r\n", undefined)).category, "promotions");
	assert.equal((await deliver("b@acme.com", "", { "list-unsubscribe": "<https://b.test/u>" })).category, "promotions");
});

test("an ordinary contact dependency error named timeout preserves normal mail and calendar intake", async (t) => {
	const { deliverRaw, raw, database } = await fixture(t);
	const originalPrepare = database.prepare.bind(database);
	let injected = false;
	let exactContactSelects = 0;
	const contactQueries = [];
	database.prepare = query => {
		if (/contacts/i.test(query)) contactQueries.push(query);
		if (/select[\s\S]+from ["`]?contacts["`]?/i.test(query) && /["`]?user_id["`]?\s*=\s*\?/.test(query) && /["`]?email["`]?\s*=\s*\?/.test(query)) {
			exactContactSelects++;
			if (!injected && exactContactSelects === 2) {
				injected = true;
				throw new Error("timeout");
			}
		}
		return originalPrepare(query);
	};
	const calendarMail = [
		"From: organizer@outside.test", "To: me@one.test", "Subject: Valid invite", "Message-ID: <valid-invite@outside.test>",
		'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="calendar"', "", "--calendar",
		"Content-Type: text/plain; charset=utf-8", "", "Please join.", "--calendar",
		'Content-Type: text/calendar; method=REQUEST; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', "",
		"BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:valid-invite@example.test",
		"DTSTART:20271104T170000Z", "DTEND:20271104T180000Z", "SUMMARY:Valid meeting",
		"ORGANIZER:mailto:organizer@outside.test", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@one.test", "END:VEVENT", "END:VCALENDAR",
		"--calendar--", "",
	].join("\r\n");
	const key = await deliverRaw(calendarMail);
	database.prepare = originalPrepare;
	assert.equal(injected, true, `the contact lookup failure was exercised: ${JSON.stringify(contactQueries)}`);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM messages WHERE raw_r2_key = ?").get(key).n, 1);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 1);
});

test("concurrent normal duplicate deliveries emit notification effects only for the completion-transition winner", async (t) => {
	const { storeRaw, raw, database, env, sent } = await fixture(t);
	t.mock.method(console, "info", () => {});
	const originalPrepare = database.prepare.bind(database);
	let dedupReads = 0;
	const preparedQueries = [];
	let releaseReaders;
	const bothReaders = new Promise((resolve) => { releaseReaders = resolve; });
	const wrap = (statement, query) => new Proxy(statement, { get(target, property) {
		if (property === "all" || property === "first" || property === "raw") return async (...args) => {
			const rows = await target[property](...args);
			if (/select[\s\S]+from ["`]?messages["`]?/i.test(query) && /raw_r2_key/.test(query)) {
				dedupReads++;
				if (dedupReads === 2) releaseReaders();
				await bothReaders;
			}
			return rows;
		};
		const value = Reflect.get(target, property, target);
		if (property === "bind" && typeof value === "function") return (...args) => wrap(value.apply(target, args), query);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	database.prepare = query => { preparedQueries.push(query); return wrap(originalPrepare(query), query); };
	const key = await storeRaw(mime("friend@outside.test"));
	const payload = { from: "bounce@outside.test", to: "me@one.test", rawR2Key: key };
	await Promise.all([m.processInboundMessage(env, payload), m.processInboundMessage(env, payload)]);
	database.prepare = originalPrepare;
	assert.equal(dedupReads, 2, `both calls passed the pre-insert duplicate lookup together: ${JSON.stringify(preparedQueries.filter(query => /messages/i.test(query)))}`);
	assert.equal(raw.prepare("SELECT count(*) AS n FROM messages WHERE raw_r2_key = ? AND intake_complete = 1").get(key).n, 1);
	assert.equal(sent.filter((entry) => entry.body.type === "new_message").length, 1);
});

test("a failed attachment writer preserves a completed replay and never acknowledges a deleted row", async (t) => {
	const attachedMime = [
		"From: friend@outside.test", "To: me@one.test", "Subject: Attachment", "Message-ID: <race-attachment@outside.test>",
		"MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="race"', "", "--race",
		"Content-Type: text/plain; charset=utf-8", "", "See attached.", "--race",
		'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"',
		"Content-Transfer-Encoding: base64", "aGVsbG8=", "--race--", "",
	].join("\r\n");
	const deferred = () => {
		let resolve;
		let reject;
		const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
		return { promise, resolve, reject };
	};

	for (const completeBeforeFailure of [true, false]) {
		const { storeRaw, raw, database, env, sent, setBucketPut } = await fixture(t);
		t.mock.method(console, "info", () => {});
		const firstPutStarted = deferred();
		const firstPut = deferred();
		let puts = 0;
		setBucketPut(async () => {
			if (puts++ === 0) {
				firstPutStarted.resolve();
				return firstPut.promise;
			}
		});
		const key = await storeRaw(attachedMime);
		const payload = { from: "bounce@outside.test", to: "me@one.test", rawR2Key: key };
		const firstAttempt = m.processInboundMessage(env, payload);
		await firstPutStarted.promise;

		let releaseMarker;
		let markerReached;
		if (!completeBeforeFailure) {
			const markerGate = deferred();
			const markerSignal = deferred();
			releaseMarker = markerGate.resolve;
			markerReached = markerSignal.promise;
			const originalPrepare = database.prepare.bind(database);
			const wrap = (statement, query) => new Proxy(statement, { get(target, property) {
				if (/update ["`]?messages["`]? set ["`]?intake_complete["`]?/i.test(query) && ["all", "raw", "run", "first"].includes(property)) {
					return async (...args) => {
						markerSignal.resolve();
						await markerGate.promise;
						return target[property](...args);
					};
				}
				const value = Reflect.get(target, property, target);
				if (property === "bind" && typeof value === "function") return (...args) => wrap(value.apply(target, args), query);
				return typeof value === "function" ? value.bind(target) : value;
			} });
			database.prepare = query => wrap(originalPrepare(query), query);
		}
		const replay = m.processInboundMessage(env, payload);
		if (completeBeforeFailure) {
			await replay;
			firstPut.reject(new Error("injected attachment PUT failure"));
			assert.equal((await Promise.allSettled([firstAttempt]))[0].status, "rejected");
			assert.equal(raw.prepare("SELECT count(*) AS n FROM messages WHERE raw_r2_key = ? AND intake_complete = 1").get(key).n, 1);
			assert.equal(raw.prepare("SELECT count(*) AS n FROM message_attachments").get().n, 1);
			assert.equal(sent.filter(entry => entry.body.type === "new_message").length, 1);
		} else {
			await markerReached;
			firstPut.reject(new Error("injected attachment PUT failure"));
			assert.equal((await Promise.allSettled([firstAttempt]))[0].status, "rejected");
			releaseMarker();
			const replayResult = await Promise.allSettled([replay]);
			assert.equal(replayResult[0].status, "rejected", "a missing row is not an acknowledged completion");
			assert.match(String(replayResult[0].reason), /disappeared before intake completed/);
			assert.equal(raw.prepare("SELECT count(*) AS n FROM messages WHERE raw_r2_key = ?").get(key).n, 0);
			assert.equal(raw.prepare("SELECT count(*) AS n FROM message_attachments").get().n, 0);
			assert.equal(sent.filter(entry => entry.body.type === "new_message").length, 0);
		}
	}
});

test("historical intake fails on a missing raw object so the poller can retry", async (t) => {
	const { env } = await fixture(t);
	await assert.rejects(
		m.processInboundMessage(env, { from: "sender@outside.test", to: "no-route@example.test", rawR2Key: "inbound/missing" }, { intakeMode: "historical_import" }),
		/Missing raw object for historical inbound message/,
	);
});

test("a sender override and a correspondent contact keep mail in Inbox", async (t) => {
	const { deliver, raw } = await fixture(t);
	raw.exec("INSERT INTO mailbox_sender_preferences (id, mailbox_id, sender_address, category_override, updated_at) VALUES ('p', 'box', 'vip@acme.com', 'inbox', 1)");
	assert.equal((await deliver("vip@acme.com", "List-Unsubscribe: <https://acme.com/u>\r\n")).category, null);
	raw.exec("INSERT INTO contacts (id, user_id, email, source, created_at) VALUES ('c', 'admin', 'pal@acme.com', 'outbound', 1)");
	assert.equal((await deliver("pal@acme.com", "List-Unsubscribe: <https://acme.com/u>\r\n")).category, null);
});

const PROMO = "List-Unsubscribe: <https://acme.com/u>\r\n";

test("a promotion in a separate mailbox is not announced, but open sessions are told to refresh", async (t) => {
	const { deliver, raw, sent } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	raw.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('box', 'separate', 1)");
	await deliver("News <n@acme.com>", PROMO);
	assert.deepEqual(sent.map((entry) => [entry.user, entry.body.type, entry.body.changed]), [["admin", "revision", true]]);
	assert.equal(typeof sent[0].body.revision, "string");
	sent.length = 0;
	await deliver("Friend <f@x.test>");
	assert.deepEqual(sent.map((entry) => entry.body.type), ["new_message"]);
	assert.equal("category" in sent[0].body, false);
});

test("a promotion is announced in show mode, in off mode and before the settings table exists, carrying its category", async (t) => {
	const { deliver, raw, sent } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	await deliver("News <n@acme.com>", PROMO);
	raw.exec("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, updated_at) VALUES ('box', 'show', 1)");
	await deliver("News <n@acme.com>", PROMO);
	raw.exec("DROP TABLE mailbox_promotion_settings");
	await deliver("News <n@acme.com>", PROMO);
	assert.deepEqual(sent.map((entry) => [entry.body.type, entry.body.category]), [["new_message", "promotions"], ["new_message", "promotions"], ["new_message", "promotions"]]);
});

test("the message.inbound webhook carries the category", async (t) => {
	const { deliver, raw } = await fixture(t);
	const quiet = console.info; console.info = () => {};
	t.after(() => { console.info = quiet; });
	const error = console.error; console.error = () => {};
	t.after(() => { console.error = error; });
	raw.exec("INSERT INTO webhooks (id, user_id, url, secret, events, enabled, created_at) VALUES ('w', 'admin', 'https://hooks.invalid/x', 's', '[\"message.inbound\"]', 1, 1)");
	await deliver("News <n@acme.com>", PROMO);
	await deliver("Friend <f@x.test>");
	const payloads = raw.prepare("SELECT payload FROM webhook_deliveries ORDER BY rowid").all().map((row) => JSON.parse(row.payload).data);
	assert.deepEqual(payloads.map((data) => data.category), ["promotions", null]);
});
