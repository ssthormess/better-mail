import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// MAILBOX_STORAGE_LIMIT_BYTES gates inbound mail twice: once before the queue,
// where the Worker handler can still bounce and the other intakes can still
// return a reject result, and once inside the queue consumer, where an accepted
// message that lands on a full mailbox is dropped with its orphaned raw object.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-quota-inbound-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const mocks = {
	"vinext/server/fetch-handler": "export default { fetch: () => new Response('mocked') };",
	"./src/lib/realtime/hub": "export class RealtimeHub {}",
};
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { intakeProviderMail } from "./src/lib/email/provider-intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { mailboxInboundQuotaExceeded, INBOUND_QUOTA_REJECT_REASON } from "./src/lib/email/mailbox-quota.ts";
			import worker from "./worker.ts";
			export const handleEmail = (message, env, ctx) => worker.email(message, env, ctx);
		`,
		resolveDir: root,
		sourcefile: "quota-inbound-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	alias: {
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
	plugins: [{
		name: "mocks",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, ({ path }) => (path in mocks ? { path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
		},
	}],
});
const {
	SqliteDatabase,
	applyMigrations,
	getDb,
	intakeIncomingMail,
	intakeProviderMail,
	processInboundMessage,
	mailboxInboundQuotaExceeded,
	INBOUND_QUOTA_REJECT_REASON,
	handleEmail,
} = await import(pathToFileURL(join(directory, "entry.mjs")).href);

// withDatabase falls back to process.env; make sure a developer's DATABASE_URL cannot leak in.
const savedEnv = {
	DATABASE_URL: process.env.DATABASE_URL,
	DATABASE_DRIVER: process.env.DATABASE_DRIVER,
	DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN,
};
delete process.env.DATABASE_URL;
delete process.env.DATABASE_DRIVER;
delete process.env.DATABASE_AUTH_TOKEN;
after(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const SEED = `
	INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'z', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('box', 'admin', 'one', 'me', 1);
`;
// A catch-all forward to team@elsewhere.test; keep_copy decides whether the mailbox stores it.
const forwardRule = (keepCopy) => `
	INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, action, forward_to, keep_copy, enabled, priority, created_at)
		VALUES ('r', 'admin', 'one', 'domain', 'box', '*', 'forward', 'team@elsewhere.test', ${keepCopy ? 1 : 0}, 1, 10, 1);
`;
// Usage already on the mailbox: one stored message whose text body is `bytes` octets.
const usedMessage = (bytes) => `
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, text_body, status, created_at)
		VALUES ('m-old', 'admin', 'box', 'inbound', 'a@x.test', 'me@one.test', '${"x".repeat(bytes)}', 'received', 1);
`;

const rawOf = (bytes) => {
	const head = "From: a@ext.test\r\nTo: me@one.test\r\nSubject: hi\r\n\r\n";
	return new TextEncoder().encode(head + "y".repeat(bytes - head.length)).buffer;
};

function emailMessage(raw, { from = "a@ext.test", to = "me@one.test" } = {}) {
	const calls = { rejected: [], forwarded: [] };
	return {
		calls,
		from,
		to,
		rawSize: raw.byteLength,
		raw: new Response(raw).body,
		headers: new Headers({ subject: "hi", from: `Sender <${from}>` }),
		setReject: (reason) => calls.rejected.push(reason),
		forward: async (destination) => { calls.forwarded.push(destination); },
	};
}

async function setup(t, { limit, seed = "" } = {}) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(SEED + seed);
	const objects = new Map();
	const queued = [];
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, value) => { objects.set(key, value); },
			get: async (key) => (objects.has(key) ? { size: objects.get(key).byteLength, arrayBuffer: async () => objects.get(key) } : null),
			head: async (key) => (objects.has(key) ? {} : null),
			delete: async (key) => { objects.delete(key); },
		},
		INBOUND_QUEUE: { send: async (payload) => { queued.push(payload); } },
		...(limit === undefined ? {} : { MAILBOX_STORAGE_LIMIT_BYTES: String(limit) }),
	};
	return { env, sqlite: database.db, objects, queued };
}

const silence = (t) => {
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "error", () => {});
	t.mock.method(console, "info", () => {});
};

test("mailboxInboundQuotaExceeded: only strictly-over rejects, no limit means unlimited", async (t) => {
	const { env, sqlite } = await setup(t, { seed: usedMessage(800) });
	const db = getDb(env);
	const limited = { ...env, MAILBOX_STORAGE_LIMIT_BYTES: "1000" };
	assert.equal(await mailboxInboundQuotaExceeded(limited, db, "box", 200), false, "800 + 200 lands exactly on the cap");
	assert.equal(await mailboxInboundQuotaExceeded(limited, db, "box", 201), true, "800 + 201 is over");
	for (const value of [undefined, "0", "-5", "junk"]) {
		const unbounded = value === undefined ? env : { ...env, MAILBOX_STORAGE_LIMIT_BYTES: value };
		assert.equal(await mailboxInboundQuotaExceeded(unbounded, db, "box", 10_000), false, `limit ${value}`);
	}
	assert.equal(sqlite.prepare("SELECT count(*) AS c FROM messages").get().c, 1, "the check writes nothing");
});

test("the Worker email handler bounces an over-quota message before storing or queueing", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(900) });
	const msg = emailMessage(rawOf(200));
	await handleEmail(msg, env, {});
	assert.deepEqual(msg.calls.rejected, [INBOUND_QUOTA_REJECT_REASON]);
	assert.equal(msg.calls.forwarded.length, 0);
	assert.equal(objects.size, 0, "storeRawToR2 never ran");
	assert.equal(queued.length, 0, "INBOUND_QUEUE.send never ran");
});

test("a keep-copy forward on a full mailbox still bounces the stored copy", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(900) + forwardRule(true) });
	// The catch-all recipient resolves to the full mailbox through the forward rule.
	const msg = emailMessage(rawOf(200), { to: "x@one.test" });
	await handleEmail(msg, env, {});
	assert.deepEqual(msg.calls.forwarded, ["team@elsewhere.test"], "the forward already left");
	assert.deepEqual(msg.calls.rejected, [INBOUND_QUOTA_REJECT_REASON], "the kept copy cannot be stored");
	assert.equal(objects.size, 0);
	assert.equal(queued.length, 0);
});

test("a pure forward is never quota-checked because nothing is stored", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(900) + forwardRule(false) });
	const msg = emailMessage(rawOf(200), { to: "x@one.test" });
	await handleEmail(msg, env, {});
	assert.deepEqual(msg.calls.forwarded, ["team@elsewhere.test"]);
	assert.deepEqual(msg.calls.rejected, []);
	assert.equal(objects.size, 0);
	assert.equal(queued.length, 0);
});

test("a message landing exactly on the cap is stored and queued", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(800) });
	const msg = emailMessage(rawOf(200));
	await handleEmail(msg, env, {});
	assert.deepEqual(msg.calls.rejected, []);
	assert.equal(objects.size, 1);
	assert.equal(queued.length, 1);
	assert.equal(queued[0].to, "me@one.test");
});

test("unset, zero and garbled limits accept mail on a mailbox over any cap", async (t) => {
	silence(t);
	for (const limit of [undefined, "0", "-5", "junk"]) {
		const { env, objects, queued } = await setup(t, { limit, seed: usedMessage(9_000_000) });
		const msg = emailMessage(rawOf(200));
		await handleEmail(msg, env, {});
		assert.deepEqual(msg.calls.rejected, [], `limit ${limit}`);
		assert.equal(queued.length, 1, `limit ${limit}`);
		assert.equal(objects.size, 1);
	}
});

test("the queue consumer drops mail a full mailbox cannot take, and removes the raw object", async (t) => {
	silence(t);
	const { env, sqlite, objects } = await setup(t, { limit: 1000, seed: usedMessage(900) });
	objects.set("inbound/test.eml", rawOf(200));
	await processInboundMessage(env, { from: "a@ext.test", to: "me@one.test", rawR2Key: "inbound/test.eml", headers: {} });
	assert.equal(objects.size, 0, "the orphaned raw object is deleted");
	assert.equal(sqlite.prepare("SELECT count(*) AS c FROM messages").get().c, 1, "no new message row");
});

test("a replayed message on a full mailbox dedupes instead of deleting the live object", async (t) => {
	silence(t);
	const { env, sqlite, objects } = await setup(t, {
		limit: 1000,
		// The stored row already references this object: a quota drop must not free it.
		seed: usedMessage(900).replace("m-old", "m-dup") + `
			UPDATE messages SET raw_r2_key = 'inbound/dup.eml' WHERE id = 'm-dup';
		`,
	});
	objects.set("inbound/dup.eml", rawOf(200));
	await processInboundMessage(env, { from: "a@ext.test", to: "me@one.test", rawR2Key: "inbound/dup.eml", headers: {} });
	assert.equal(objects.size, 1, "the referenced object survives");
	assert.equal(sqlite.prepare("SELECT count(*) AS c FROM messages").get().c, 1);
});

test("the queue consumer still stores mail landing exactly on the cap", async (t) => {
	silence(t);
	const { env, sqlite, objects } = await setup(t, { limit: 1000, seed: usedMessage(800) });
	objects.set("inbound/test.eml", rawOf(200));
	await processInboundMessage(env, { from: "a@ext.test", to: "me@one.test", rawR2Key: "inbound/test.eml", headers: {} });
	assert.equal(objects.size, 1, "the stored message keeps its raw object");
	const rows = sqlite.prepare("SELECT mailbox_id FROM messages WHERE raw_r2_key = 'inbound/test.eml'").all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].mailbox_id, "box");
});

test("intakeIncomingMail answers reject over quota before writing the object", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(900) });
	const rejected = [];
	const result = await intakeIncomingMail(
		env,
		{ from: "a@ext.test", to: "me@one.test", raw: rawOf(200), headers: {} },
		{ reject: (reason) => { rejected.push(reason); }, forward: async () => true },
	);
	assert.deepEqual(result, { action: "reject", reason: INBOUND_QUOTA_REJECT_REASON });
	assert.deepEqual(rejected, [INBOUND_QUOTA_REJECT_REASON], "the SMTP listener can 550 with it");
	assert.equal(objects.size, 0);
	assert.equal(queued.length, 0);
});

test("intakeIncomingMail stores an under-quota message exactly like before", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(500) });
	const result = await intakeIncomingMail(
		env,
		{ from: "a@ext.test", to: "me@one.test", raw: rawOf(200), headers: {} },
		{ reject: () => assert.fail("must not reject"), forward: async () => true },
	);
	assert.equal(result.action, "store");
	assert.equal(objects.size, 1);
	assert.equal(queued.length, 1);
});

test("provider intake drops over-quota mail without storing anything it cannot reject", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, { limit: 1000, seed: usedMessage(900) });
	const result = await intakeProviderMail(env, { from: "a@ext.test", recipients: ["me@one.test"], raw: rawOf(200) });
	assert.equal(result.delivered, 0);
	assert.equal(result.dropped, null, "per-recipient drops are silent to the provider");
	assert.equal(objects.size, 0);
	assert.equal(queued.length, 0);
});
