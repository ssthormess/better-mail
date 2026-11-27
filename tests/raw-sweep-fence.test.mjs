import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("raw-sweep-fence", `
	export { sweepOrphanedRawMail } from "./src/lib/email/raw-sweeper.ts";
	export { processInboundMessage } from "./src/lib/email/inbound.ts";
	export { inboundStorageKey } from "./src/lib/email/inbound-id.ts";
`);

const MIME = [
	"From: sender@example.test", "To: me@one.test", "Subject: race me",
	"Message-ID: <race-1@example.test>", "Date: Thu, 26 Nov 2026 10:00:00 +0000",
	"MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "fence body", "",
].join("\r\n");

/**
 * An in-memory mailbox with a D1-shaped binding (prepare/batch only, no interactive transaction) so
 * intake and the sweeper exercise the trigger/marker fence path used on workerd.
 */
async function d1Fixture(t) {
	const { env, sqlite } = await newDatabase(t, `
		INSERT INTO users (id,email,password_hash,name,created_at,spam_protection_enabled) VALUES ('owner','owner@example.test','fixture','Owner',1,0);
		INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('domain','owner','one.test','zone','active',1);
		INSERT INTO mailboxes (id,user_id,domain_id,local_part,created_at) VALUES ('mailbox','owner','domain','me',1);
	`);
	const database = env.DB;
	env.DB = {
		prepare: query => database.prepare(query),
		batch: statements => database.batch(statements),
	};
	env.MAILFLARE_RUNTIME = "workerd";
	env.REALTIME = { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) };
	const objects = new Map();
	const uploaded = new Date(Date.now() - 48 * 3600_000);
	env.BUCKET = {
		get: async key => (objects.has(key) ? { arrayBuffer: async () => objects.get(key).buffer.slice(objects.get(key).byteOffset, objects.get(key).byteOffset + objects.get(key).byteLength) } : null),
		put: async (key, value) => { objects.set(key, value instanceof ArrayBuffer ? new Uint8Array(value) : value); },
		delete: async key => { objects.delete(key); },
		list: async ({ prefix, cursor, limit }) => {
			const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
			const start = cursor === undefined ? 0 : Math.max(0, keys.findIndex(key => key > cursor));
			const page = keys.slice(start, start + limit);
			const truncated = start + page.length < keys.length;
			return { objects: page.map(key => ({ key, uploaded })), truncated, cursor: truncated ? page.at(-1) : undefined };
		},
	};
	const bytes = new TextEncoder().encode(MIME).buffer;
	const key = await app.inboundStorageKey(bytes, "mailbox");
	const payload = { from: "sender@example.test", to: "me@one.test", rawR2Key: key };
	const opts = { intakeMode: "historical_import", rawBytes: bytes };
	const row = () => sqlite.prepare("SELECT id FROM messages WHERE raw_r2_key=?").get(key);
	const mark = () => sqlite.prepare("SELECT raw_r2_key,claim_token,claimed_at,delete_complete FROM raw_sweep_pending_deletes WHERE raw_r2_key=?").get(key);
	return { env, sqlite, objects, bytes, key, payload, opts, row, mark };
}

test("d1 marker path: an intake committed before the sweep keeps its raw object (d1-insert-first)", async (t) => {
	const f = await d1Fixture(t);
	f.objects.set(f.key, new Uint8Array(f.bytes));
	await app.processInboundMessage(f.env, f.payload, f.opts);
	// A populated mailbox means every stored raw key is an aged referenced key: the sweep must skip it
	// through the reference check instead of propagating the wrapped trigger abort.
	assert.equal(await app.sweepOrphanedRawMail(f.env), 0);
	assert.equal(!!f.row(), true);
	assert.equal(f.objects.has(f.key), true);
});

test("d1 marker path: intake waits out a live claim, then re-stores and commits (d1-pause-delete)", async (t) => {
	const f = await d1Fixture(t);
	f.objects.set(f.key, new Uint8Array(f.bytes));
	let release;
	const reached = new Promise(resolve => { f.reachedDelete = resolve; });
	const wait = new Promise(resolve => { release = resolve; });
	const realDelete = f.env.BUCKET.delete;
	let began = false;
	f.env.BUCKET.delete = async key => {
		if (key === f.key && !began) { began = true; f.reachedDelete(); await wait; }
		return realDelete(key);
	};
	const sweep = app.sweepOrphanedRawMail(f.env);
	await reached;
	const intake = app.processInboundMessage(f.env, f.payload, f.opts).then(() => "ok", e => `err:${e.message.split("\n")[0]}`);
	await new Promise(resolve => setTimeout(resolve, 200));
	release();
	assert.equal(await sweep, 1);
	assert.equal(await intake, "ok");
	assert.equal(!!f.row(), true);
	assert.ok(Buffer.from(f.objects.get(f.key)).equals(Buffer.from(f.bytes)), "the intake re-stored the deleted generation");
	assert.equal(await app.processInboundMessage(f.env, f.payload, f.opts).then(() => "ok", e => `err:${e.message}`), "ok");
});

test("d1 marker path: a complete claim→delete→complete cycle in the GET→insert gap cannot commit dangling (d1-race-full-cycle)", async (t) => {
	const f = await d1Fixture(t);
	const database = f.env.DB;
	// Stall the first INSERT INTO messages so the entire sweep cycle lands in intake's GET→insert gap.
	let releaseInsert;
	const gate = new Promise(resolve => { releaseInsert = resolve; });
	let stalled;
	const insertStalled = new Promise(resolve => { stalled = resolve; });
	const wrap = statement => new Proxy(statement, {
		get(target, prop) {
			if (prop === "bind") return (...args) => wrap(target.bind(...args));
			if (["all", "run", "first", "raw"].includes(prop)) return async (...args) => { stalled(); await gate; return target[prop](...args); };
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	let gateUsed = false;
	f.env.DB = {
		prepare: query => {
			const statement = database.prepare(query);
			if (!gateUsed && /insert into ["`]?messages["`]?/i.test(query)) { gateUsed = true; return wrap(statement); }
			return statement;
		},
		batch: statements => database.batch(statements),
	};
	f.objects.set(f.key, new Uint8Array(f.bytes));
	const intake = app.processInboundMessage(f.env, f.payload, f.opts);
	await insertStalled;
	assert.equal(await app.sweepOrphanedRawMail(f.env), 1, "the whole claim→delete→complete cycle runs in the gap");
	releaseInsert();
	const intakeRes = await intake.then(() => "ok", e => `err:${e.message.split("\n")[0]}`);
	assert.equal(intakeRes, "ok");
	assert.equal(!!f.row(), true);
	assert.equal(f.objects.has(f.key), true, "a committed reference must point at a live object, never a deleted one");
});

test("d1 marker path: a never-completed stale claim is released by the sweep and intake then succeeds (stale-marker)", async (t) => {
	const f = await d1Fixture(t);
	f.objects.set(f.key, new Uint8Array(f.bytes));
	const nowSec = Math.floor(Date.now() / 1000);
	f.sqlite.prepare("INSERT INTO raw_sweep_pending_deletes (raw_r2_key,claim_token,claimed_at,delete_complete) VALUES (?,?,?,0)").run(f.key, "stale-claim", nowSec);
	// The claim is fresh, so the intake waits briefly then reports a retryable cleanup-in-progress.
	const intake = await app.processInboundMessage(f.env, f.payload, f.opts).then(() => "ok", e => `err:${e.message.split("\n")[0]}`);
	assert.match(intake, /^err:Raw object cleanup is in progress/);
	// After the stale window the same sweep both releases the dead claim and reclaims the orphan.
	assert.equal(await app.sweepOrphanedRawMail(f.env, new Date(Date.now() + 25 * 3600_000)), 1);
	assert.equal(f.objects.has(f.key), false);
	assert.equal(await app.sweepOrphanedRawMail(f.env, new Date(Date.now() + 50 * 3600_000)), 0);
	assert.equal(await app.processInboundMessage(f.env, f.payload, f.opts).then(() => "ok", e => `err:${e.message.split("\n")[0]}`), "ok");
	assert.equal(!!f.row(), true);
	assert.equal(f.objects.has(f.key), true);
});

test("d1 marker path: a retained complete marker is consumed inline by the intake (complete-marker)", async (t) => {
	const f = await d1Fixture(t);
	const nowSec = Math.floor(Date.now() / 1000);
	// Crash between recording delete_complete and clearing the marker: the object is already gone.
	f.sqlite.prepare("INSERT INTO raw_sweep_pending_deletes (raw_r2_key,claim_token,claimed_at,delete_complete) VALUES (?,?,?,1)").run(f.key, "done-claim", nowSec);
	assert.equal(await app.processInboundMessage(f.env, f.payload, f.opts).then(() => "ok", e => `err:${e.message.split("\n")[0]}`), "ok",
		"a durably completed claim must not block intake until the next daily sweep");
	assert.equal(!!f.row(), true);
	assert.equal(f.objects.has(f.key), true);
	assert.equal(f.mark() ?? null, null, "the intake consumed the completed marker");
	assert.equal(await app.sweepOrphanedRawMail(f.env, new Date(Date.now() + 2 * 3600_000)), 0);
	assert.equal(await app.processInboundMessage(f.env, f.payload, f.opts).then(() => "ok", e => `err:${e.message.split("\n")[0]}`), "ok");
});
