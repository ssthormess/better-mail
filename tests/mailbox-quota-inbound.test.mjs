import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import readline from "node:readline";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// MAILBOX_STORAGE_LIMIT_BYTES gates inbound mail at three points: before the
// queue, where the Worker handler can still bounce and the SMTP listener still
// answers a per-recipient 550; inside intake, where an accepted recipient that
// no longer fits is dropped for that recipient only; and inside the queue
// consumer, where the real parsed size is checked before anything is stored.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-quota-inbound-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const mocks = {
	"vinext/server/fetch-handler": "export default { fetch: () => new Response('mocked') };",
	"./src/lib/realtime/hub": "export class RealtimeHub {}",
	// SPF/DKIM/DMARC verification would hit the network; the checks under test do not read verdicts.
	"./smtp-auth": "export async function verifySmtpAuthentication() { return {}; }",
};
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { startSmtpListener } from "./server/runtime/smtp.ts";
			export { getDb } from "./src/db/index.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { intakeProviderMail } from "./src/lib/email/provider-intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { parseRawMime } from "./src/lib/email/parse.ts";
			export { boundParsedEmail } from "./src/lib/email/inbound-limits.ts";
			export { getMailboxUsage } from "./src/lib/mailboxes/usage.ts";
			export { estimateInboundStoredBytes, mailboxInboundQuotaExceeded, INBOUND_QUOTA_REJECT_REASON } from "./src/lib/email/mailbox-quota.ts";
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
	startSmtpListener,
	getDb,
	intakeIncomingMail,
	intakeProviderMail,
	processInboundMessage,
	parseRawMime,
	boundParsedEmail,
	getMailboxUsage,
	estimateInboundStoredBytes,
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
	assert.equal(objects.size, 0, "no raw object was staged");
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

test("the queue consumer's boundary is the parsed stored size, not the raw size", async (t) => {
	silence(t);
	const raw = rawOf(400);
	// The stored size is what getMailboxUsage counts: parsed bodies + attachments.
	const storedBytes = estimateInboundStoredBytes(boundParsedEmail(await parseRawMime(raw)));
	assert.ok(storedBytes > 0 && storedBytes < 1000);
	const fitting = await setup(t, { limit: 1000, seed: usedMessage(1000 - storedBytes) });
	fitting.objects.set("inbound/test.eml", raw);
	await processInboundMessage(fitting.env, { from: "a@ext.test", to: "me@one.test", rawR2Key: "inbound/test.eml", headers: {} });
	assert.equal(fitting.sqlite.prepare("SELECT count(*) AS c FROM messages").get().c, 2, "landing exactly on the cap stores");
	assert.equal(fitting.objects.size, 1, "the stored message keeps its raw object");
	const over = await setup(t, { limit: 1000, seed: usedMessage(1001 - storedBytes) });
	over.objects.set("inbound/test.eml", raw);
	await processInboundMessage(over.env, { from: "a@ext.test", to: "me@one.test", rawR2Key: "inbound/test.eml", headers: {} });
	assert.equal(over.sqlite.prepare("SELECT count(*) AS c FROM messages").get().c, 1, "one byte of prior usage more drops it");
	assert.equal(over.objects.size, 0);
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

test("an 8-bit body that decodes larger than its raw size is dropped by the consumer", async (t) => {
	silence(t);
	const { env, sqlite, objects, queued } = await setup(t, { limit: 1500 });
	// 1024 raw 0xe9 octets decode to 2048 UTF-8 bytes: ~1.2 KiB raw passes every
	// raw-size gate but ~2 KiB stored blows the 1500 cap — the consumer must
	// measure the real parsed size, not trust the raw estimate.
	const bytes = Buffer.concat([
		Buffer.from("From: a@ext.test\r\nTo: me@one.test\r\nSubject: hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"),
		Buffer.alloc(1024, 0xe9),
		Buffer.from("\r\n"),
	]);
	const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	assert.ok(raw.byteLength < 1500, "the fixture itself fits the raw estimate");
	const result = await intakeIncomingMail(env, { from: "a@ext.test", to: "me@one.test", raw, headers: {} }, { forward: async () => true });
	assert.equal(result.action, "store", "raw size fits, so intake stores and queues");
	await processInboundMessage(env, queued[0]);
	assert.equal(sqlite.prepare("SELECT count(*) AS c FROM messages").get().c, 0, "stored size is over the cap: dropped");
	assert.equal(objects.size, 0, "the staged object is removed");
	assert.equal((await getMailboxUsage(getDb(env), "box")).totalBytes, 0);
});

test("the SMTP listener rejects an over-quota recipient at RCPT and drops a late overflow at DATA only", async (t) => {
	silence(t);
	const { env, objects, queued } = await setup(t, {
		limit: 1000,
		// me@one.test ('box') has room; full@ is already over the cap; late@ fits at
		// RCPT but the body pushes it over at DATA; sized@ only overflows once the
		// declared SIZE argument is folded into its usage.
		seed: `
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
				('full', 'admin', 'one', 'full', 1),
				('late', 'admin', 'one', 'late', 1),
				('sized', 'admin', 'one', 'sized', 1);
			INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, text_body, status, created_at) VALUES
				('m-full', 'admin', 'full', 'inbound', 'a@x.test', 'full@one.test', '${"f".repeat(1100)}', 'received', 1),
				('m-late', 'admin', 'late', 'inbound', 'a@x.test', 'late@one.test', '${"l".repeat(900)}', 'received', 1),
				('m-sized', 'admin', 'sized', 'inbound', 'a@x.test', 'sized@one.test', '${"s".repeat(900)}', 'received', 1);
		`,
	});
	const server = startSmtpListener(env, { sendRaw: async () => true }, { port: 0, host: "127.0.0.1", maxSize: 65536, hostname: "mx.one.test", tls: null });
	t.after(async () => new Promise((resolve) => server.close(resolve)));
	await once(server.server, "listening");
	const socket = net.connect({ host: "127.0.0.1", port: server.server.address().port });
	t.after(() => socket.destroy());
	const lines = readline.createInterface({ input: socket })[Symbol.asyncIterator]();
	const reply = async (wire) => {
		if (wire) socket.write(wire);
		for (;;) {
			const { value, done } = await lines.next();
			if (done) throw Error("SMTP socket closed");
			if (/^\d{3} /.test(value)) return value;
		}
	};
	const session = [
		await reply(),
		await reply("EHLO sender.example\r\n"),
		await reply("MAIL FROM:<sender@example.test>\r\n"),
		await reply("RCPT TO:<me@one.test>\r\n"),
		await reply("RCPT TO:<full@one.test>\r\n"),
		await reply("RCPT TO:<late@one.test>\r\n"),
		await reply("DATA\r\n"),
		await reply(`From: sender@example.test\r\nTo: me@one.test, full@one.test, late@one.test\r\nSubject: t\r\n\r\n${"a".repeat(150)}\r\n.\r\n`),
	];
	assert.deepEqual(
		session.map((line) => line.slice(0, 3)),
		["220", "250", "250", "250", "550", "250", "354", "250"],
		"the over-quota RCPT gets its own 550 and the transaction still completes for the rest",
	);
	assert.deepEqual(queued.map((item) => item.to), ["me@one.test"], "only the fitting recipient is queued");
	assert.equal(objects.size, 1, "a staged raw exists for the queued delivery alone");
	assert.match(await reply("RSET\r\n"), /^250/);
	assert.match(await reply("MAIL FROM:<sender@example.test> SIZE=105\r\n"), /^250/);
	assert.match(await reply("RCPT TO:<sized@one.test>\r\n"), /^550/, "usage + declared SIZE over the cap refuses at RCPT");
	assert.match(await reply("RSET\r\n"), /^250/);
	assert.match(await reply("MAIL FROM:<sender@example.test>\r\n"), /^250/);
	assert.match(await reply("RCPT TO:<sized@one.test>\r\n"), /^250/, "without SIZE the same mailbox is accepted on usage alone");
	assert.match(await reply("QUIT\r\n"), /^221/);
});

test("the SMTP listener only bounces decisions that really store, and only claims 250 when something delivered", async (t) => {
	silence(t);
	const { env, sqlite, objects, queued } = await setup(t, {
		limit: 1000,
		// fwd@ is the fallback mailbox on a domain catch-all forward and already over
		// cap; solo@ fits at RCPT but not once the body arrives; direct@ is an
		// over-cap mailbox with its own mailbox-scope forward rule, which can only
		// be evaluated at DATA when the headers exist.
		seed: `
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
				('fwd', 'admin', 'one', 'fwd', 1),
				('solo', 'admin', 'one', 'solo', 1),
				('direct', 'admin', 'one', 'direct', 1);
			INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, text_body, status, created_at) VALUES
				('m-fwd', 'admin', 'fwd', 'inbound', 'a@x.test', 'fwd@one.test', '${"f".repeat(1100)}', 'received', 1),
				('m-solo', 'admin', 'solo', 'inbound', 'a@x.test', 'solo@one.test', '${"s".repeat(950)}', 'received', 1),
				('m-direct', 'admin', 'direct', 'inbound', 'a@x.test', 'direct@one.test', '${"d".repeat(1100)}', 'received', 1);
			INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, action, forward_to, keep_copy, enabled, priority, created_at) VALUES
				('pf', 'admin', 'one', 'domain', 'fwd', '*', 'forward', 'team@elsewhere.test', 0, 1, 10, 1),
				('mf', 'admin', 'one', 'mailbox', 'direct', '*', 'forward', 'dest@somewhere.test', 0, 1, 10, 1);
		`,
	});
	const forwarded = [];
	const server = startSmtpListener(env, { sendRaw: async (_from, to) => { forwarded.push(to); return true; } }, { port: 0, host: "127.0.0.1", maxSize: 65536, hostname: "mx.one.test", tls: null });
	t.after(async () => new Promise((resolve) => server.close(resolve)));
	await once(server.server, "listening");
	const socket = net.connect({ host: "127.0.0.1", port: server.server.address().port });
	t.after(() => socket.destroy());
	const lines = readline.createInterface({ input: socket })[Symbol.asyncIterator]();
	const reply = async (wire) => {
		if (wire) socket.write(wire);
		for (;;) {
			const { value, done } = await lines.next();
			if (done) throw Error("SMTP socket closed");
			if (/^\d{3} /.test(value)) return value;
		}
	};
	await reply();
	await reply("EHLO sender.example\r\n");
	// A forward that keeps no copy stores nothing: the fallback mailbox being over
	// cap must not bounce it at RCPT.
	assert.match(await reply("MAIL FROM:<sender@example.test>\r\n"), /^250/);
	assert.match(await reply("RCPT TO:<nobody@one.test>\r\n"), /^250/, "pure forward stays accepted");
	assert.match(await reply("DATA\r\n"), /^354/);
	assert.match(await reply("From: s@x.test\r\nTo: nobody@one.test\r\n\r\nhi\r\n.\r\n"), /^250/);
	assert.deepEqual(forwarded, ["team@elsewhere.test"], "the forward ran");
	assert.equal(objects.size, 0, "nothing staged");
	assert.equal(queued.length, 0, "nothing queued");
	// The same rule keeping a copy does store — the over-cap fallback refuses at RCPT.
	sqlite.exec("UPDATE routing_rules SET keep_copy = 1 WHERE id = 'pf'");
	assert.match(await reply("MAIL FROM:<sender@example.test>\r\n"), /^250/);
	assert.match(await reply("RCPT TO:<nobody@one.test>\r\n"), /^550/, "keep-copy forward on an over-cap fallback refuses at RCPT");
	assert.match(await reply("RSET\r\n"), /^250/);
	// A direct mailbox with a forward rule is provisional at RCPT — the rule needs
	// headers DATA hasn't seen, so the cap verdict waits and the forward still runs.
	assert.match(await reply("MAIL FROM:<sender@example.test>\r\n"), /^250/);
	assert.match(await reply("RCPT TO:<direct@one.test>\r\n"), /^250/, "mailbox forward rules defer the quota verdict to DATA");
	assert.match(await reply("DATA\r\n"), /^354/);
	assert.match(await reply("From: s@x.test\r\nTo: direct@one.test\r\n\r\nhi\r\n.\r\n"), /^250/);
	assert.deepEqual(forwarded, ["team@elsewhere.test", "dest@somewhere.test"]);
	// A sole accepted recipient that drops at DATA with zero delivery side effects
	// is a real bounce, not a false "queued".
	assert.match(await reply("MAIL FROM:<sender@example.test>\r\n"), /^250/);
	assert.match(await reply("RCPT TO:<solo@one.test>\r\n"), /^250/, "solo fits until the real size is known");
	assert.match(await reply("DATA\r\n"), /^354/);
	const end = await reply("From: s@x.test\r\nTo: solo@one.test\r\n\r\n" + "a".repeat(150) + "\r\n.\r\n");
	assert.match(end, /^550/, "all recipients dropped with no delivery is a bounce");
	assert.match(end, /storage limit/, "carries the quota reason");
	assert.equal(queued.length, 0);
	assert.equal(objects.size, 0);
	assert.match(await reply("QUIT\r\n"), /^221/);
});
