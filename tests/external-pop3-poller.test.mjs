import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(root, "node_modules", "external-pop3-poller-test-"));
after(() => rmSync(out, { recursive: true, force: true }));
await build({
 stdin: { contents: `
  export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
  export { applyMigrations } from "./server/runtime/migrate.ts";
  export { pollExternalAccounts } from "./src/lib/external-accounts/poller.ts";
  export { encryptSecret } from "./src/lib/external-accounts/crypto.ts";
  export { pop3UidlHash } from "./src/lib/external-accounts/cursor.ts";
 `, resolveDir: root, sourcefile: "external-pop3-poller-test.ts" },
 outfile: join(out, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external",
 alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" }, logLevel: "silent",
});
const m = await import(pathToFileURL(join(out, "entry.mjs")));
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const PASSWORD = "poller-password-secret";
const DEFAULT_RAW = "From: sender@outside.test\r\nTo: me@one.test\r\nSubject: imported\r\nMessage-ID: <same@outside.test>\r\nDate: Thu, 19 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nhello\r\n";

/** Dot-stuffs raw bytes the way a server sends them, then appends the CRLF-quoted terminator. */
function wire(bytes) {
 const parts = [];
 let start = bytes.length >= 1 && bytes[0] === 0x2e ? 1 : 0;
 if (start) parts.push(Buffer.from("."));
 for (let i = 0; i <= bytes.length - 4; i++) {
  if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x2e) {
   parts.push(bytes.subarray(start, i + 2), Buffer.from("."));
   start = i + 2;
   i = start;
  }
 }
 parts.push(bytes.subarray(start));
 return Buffer.concat([...parts, Buffer.from("\r\n.\r\n")]);
}

function makeServer({ messages = [[1, "uidl-one", DEFAULT_RAW]], failAuth = false, noUidl = false, pauseRetr = false } = {}) {
 const state = { messages, failAuth, noUidl, pauseRetr, resumeRetr: null, commands: [], connections: 0 };
 const server = createServer(socket => {
  state.connections++;
  socket.on("error", () => {});
  socket.write("+OK fake pop3\r\n");
  let buffer = "";
  socket.on("data", chunk => {
   buffer += chunk.toString("binary"); let end;
   while ((end = buffer.indexOf("\r\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); state.commands.push(line);
    if (line.startsWith("USER")) socket.write(state.failAuth ? `-ERR nope ${PASSWORD}\r\n` : "+OK\r\n");
    else if (line.startsWith("PASS")) socket.write(state.failAuth ? `-ERR leaked payload ${PASSWORD}\r\n` : "+OK\r\n");
    else if (line === "STAT") socket.write(`+OK ${state.messages.length} ${state.messages.reduce((sum, entry) => sum + entry[2].length, 0)}\r\n`);
    else if (line === "UIDL") socket.write(state.noUidl ? "-ERR not supported\r\n" : `+OK\r\n${state.messages.map(([num, uidl]) => `${num} ${uidl}\r\n`).join("")}.\r\n`);
    else if (line.startsWith("LIST")) {
     const entry = state.messages.find(([num]) => num === Number(line.split(" ")[1]));
     socket.write(entry ? `+OK ${entry[0]} ${entry[2].length}\r\n` : "-ERR no such message\r\n");
    } else if (line.startsWith("RETR")) {
     const entry = state.messages.find(([num]) => num === Number(line.split(" ")[1]));
     const reply = () => {
      if (!entry) { socket.write("-ERR no such message\r\n"); return; }
      const bytes = Buffer.isBuffer(entry[2]) ? entry[2] : Buffer.from(entry[2], "binary");
      socket.write(Buffer.concat([Buffer.from("+OK\r\n"), wire(bytes)]));
     };
     if (state.pauseRetr) state.resumeRetr = reply; else reply();
    } else socket.write("+OK\r\n");
   }
  });
 });
 return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ state, server, port: server.address().port })));
}

/* The poller's auth-backoff map is process-local and keyed by account id, so every fixture gets a unique id;
   reusing "account" would let a failing poll in one test suppress the next test's poll. */
let accountSeq = 0;

async function fixture(t, options = {}) {
 const server = await makeServer(options); t.after(() => server.server.close());
 const database = new m.SqliteDatabase(options.databasePath ?? ":memory:"); t.after(() => database.db.close());
 await m.applyMigrations(database, join(root, "drizzle/migrations"));
 const sql = database.db;
 sql.exec(`
  INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
  INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'one.test', 'zone', 'active', 1);
  INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox', 'owner', 'domain', 'me', 1);
 `);
 const objects = new Map(); const effects = { realtime: 0, autoReply: 0, webhook: 0 };
 const env = { DB: database, MAILFLARE_RUNTIME: "node", EXTERNAL_FETCH_ALLOW_PRIVATE: "1", MAILFLARE_ENCRYPTION_KEY: KEY, OUTBOUND_QUEUE: { send: async () => { effects.autoReply++; } }, BUCKET: {
  put: async (key, value) => objects.set(key, Buffer.from(value)),
  get: async key => objects.has(key) ? { arrayBuffer: async () => { const value = objects.get(key); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } } : null,
  delete: async key => objects.delete(key),
 } };
 const sealed = await m.encryptSecret(env, PASSWORD);
 const accountId = options.accountId ?? `account-${++accountSeq}`;
 const insert = (id = accountId, { enabled = 1, cursor = null, protocol = "pop3" } = {}) => sql.prepare(`INSERT INTO external_accounts
  (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, last_synced_at, last_error, sync_cursor, created_at, updated_at)
  VALUES (?, 'mailbox', 'owner', ?, ?, ?, 'none', ?, ?, ?, NULL, NULL, ?, 1, 1)`).run(id, protocol, "127.0.0.1", server.port, id, sealed, enabled, cursor);
 insert();
 env.REALTIME = { getByName: () => ({ fetch: async () => { effects.realtime++; return new Response(null, { status: 204 }); } }) };
 return { env, sql, database, server, objects, effects, insert, accountId, poll: now => m.pollExternalAccounts(env, now) };
}

const muteInboundLogs = t => {
 for (const method of ["error", "warn", "info", "log"]) t.mock.method(console, method, () => {});
};

test("poll fetches, processes through the canonical inbound consumer and persists cursor and sync state", async t => {
 muteInboundLogs(t); const f = await fixture(t); const now = new Date();
 f.sql.exec("UPDATE mailboxes SET auto_reply_enabled = 1, auto_reply_body = 'old reply' WHERE id='mailbox'");
 f.sql.prepare("INSERT INTO webhooks (id, user_id, url, secret, events, enabled, created_at) VALUES ('hook', 'owner', 'https://hooks.invalid/', 'secret', ?, 1, 1)").run(JSON.stringify(["message.inbound"]));
 t.mock.method(globalThis, "fetch", async url => { if (String(url).includes("hooks.invalid")) f.effects.webhook++; return new Response("ok"); });
 const result = await f.poll(now); assert.deepEqual(result, { accounts: 1 });
 const account = f.sql.prepare("SELECT sync_cursor, last_synced_at, last_error FROM external_accounts WHERE id = ?").get(f.accountId);
 const cursor = JSON.parse(account.sync_cursor);
 assert.deepEqual(cursor.uidls, [await m.pop3UidlHash("uidl-one")]); assert.ok(cursor.lastCheckedAt); assert.ok(account.last_synced_at); assert.equal(account.last_error, null);
 const messages = f.sql.prepare("SELECT mailbox_id, direction, subject, provider_message_id, raw_r2_key FROM messages").all();
 assert.equal(messages.length, 1); assert.equal(messages[0].mailbox_id, "mailbox"); assert.equal(messages[0].direction, "inbound"); assert.equal(messages[0].subject, "imported");
 assert.equal(messages[0].provider_message_id, "<same@outside.test>"); assert.ok(f.objects.has(messages[0].raw_r2_key));
 assert.equal(f.effects.realtime, 0, "notifications suppressed"); assert.equal(f.effects.autoReply, 0, "auto-replies suppressed"); assert.equal(f.effects.webhook, 0, "webhooks suppressed");
 assert.ok(!f.server.state.commands.some(command => command.startsWith("DELE")), "mail is left on the server");
});

test("a re-poll with no new mail issues no RETR and re-commits the cursor", async t => {
 muteInboundLogs(t); const f = await fixture(t); const at = new Date(); await f.poll(at);
 const retrs = f.server.state.commands.filter(command => command.startsWith("RETR")).length;
 const first = f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor;
 const result = await f.poll(new Date(at.getTime() + 61_000));
 assert.deepEqual(result, { accounts: 1 });
 assert.equal(f.server.state.commands.filter(command => command.startsWith("RETR")).length, retrs, "no refetch when the UIDL set is unchanged");
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 const second = JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor);
 assert.deepEqual(second.uidls, JSON.parse(first).uidls);
 assert.ok(second.lastCheckedAt > JSON.parse(first).lastCheckedAt);
});

test("a crash after canonical store but before cursor commit is idempotent on retry", async t => {
 muteInboundLogs(t); const f = await fixture(t); const originalPrepare = f.database.prepare.bind(f.database); let fail = true;
 f.database.prepare = sql => {
  const setClause = sql.match(/update\s+["`]?external_accounts["`]?\s+set([\s\S]*?)\s+where/i)?.[1] ?? "";
  if (fail && /["`]?sync_cursor["`]?\s*=/i.test(setClause)) { fail = false; throw new Error(`simulated commit failure; ${PASSWORD}`); }
  return originalPrepare(sql);
 };
 const at = new Date(); await f.poll(at);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.equal(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor, null);
 f.database.prepare = originalPrepare;
 const retried = await f.poll(new Date(at.getTime() + 121_000));
 assert.deepEqual(retried, { accounts: 1 });
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1, "the retried fetch deduplicated on the raw key");
 assert.deepEqual(JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor).uidls, [await m.pop3UidlHash("uidl-one")]);
});

test("a UIDL evicted past the cursor bound refetches and dedups on the raw key", async t => {
 muteInboundLogs(t); const f = await fixture(t); const at = new Date(); await f.poll(at);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 const realHash = await m.pop3UidlHash("uidl-one");
 // Fill the cursor to just under the 64 KiB byte bound so the next UIDL forces the oldest entry out;
 // sha256-hex UIDLs make the byte bound the effective cap long before the 4096 count cap is reached.
 const encoder = new TextEncoder(); const filler = [];
 while (encoder.encode(JSON.stringify({ uidls: filler, lastCheckedAt: at.toISOString() })).byteLength + 67 <= 64 * 1024) filler.push(`${filler.length}`.padStart(64, "0"));
 f.sql.prepare("UPDATE external_accounts SET sync_cursor = ?").run(JSON.stringify({ uidls: filler, lastCheckedAt: at.toISOString() }));
 await f.poll(new Date(at.getTime() + 61_000));
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1, "refetched bytes deduplicated instead of storing a second message");
 const cursor = JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor);
 assert.equal(cursor.uidls.length, filler.length, "the byte bound evicted the oldest entry to make room");
 assert.ok(!cursor.uidls.includes(filler[0]), "the oldest filler is the evicted entry");
 assert.ok(cursor.uidls.at(-1) === realHash, "the refetched UIDL re-enters the capped set as newest");
 assert.ok(!cursor.uidls.slice(0, -1).includes(realHash));
});

test("a cursor that lost the stored UIDL refetches but never duplicates the message row", async t => {
 muteInboundLogs(t); const f = await fixture(t); const at = new Date(); await f.poll(at);
 f.sql.prepare("UPDATE external_accounts SET sync_cursor = NULL").run();
 await f.poll(new Date(at.getTime() + 61_000));
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages WHERE provider_message_id = '<same@outside.test>'").get().n, 1);
});

test("a permanently oversized message is recorded in skippedUidls and never fetched again", async t => {
 muteInboundLogs(t);
 const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61).toString("binary");
 const messages = [[1, "small-a", "From: a@outside.test\r\nTo: me@one.test\r\nSubject: before\r\nMessage-ID: <a@outside.test>\r\n\r\nsmall\r\n"], [2, "too-big", big], [3, "small-c", "From: c@outside.test\r\nTo: me@one.test\r\nSubject: after\r\nMessage-ID: <c@outside.test>\r\n\r\nafter\r\n"]];
 const f = await fixture(t, { messages }); const at = new Date(); await f.poll(at);
 const subjects = f.sql.prepare("SELECT subject FROM messages ORDER BY subject").all().map(row => row.subject);
 assert.deepEqual(subjects, ["after", "before"]);
 const state = f.sql.prepare("SELECT sync_cursor, last_error FROM external_accounts").get();
 const cursor = JSON.parse(state.sync_cursor);
 assert.deepEqual(cursor.skippedUidls, [await m.pop3UidlHash("too-big")]);
 assert.match(state.last_error, /oversized messages skipped/i);
 assert.ok(!f.server.state.commands.some(command => command === "RETR 2"), "the oversized message was never retrieved");
 await f.poll(new Date(at.getTime() + 61_000));
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
 const again = JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor);
 assert.deepEqual(again.skippedUidls, cursor.skippedUidls, "the skip persists across polls instead of refetching");
 assert.ok(!f.server.state.commands.some(command => command === "RETR 2"));
});

test("a server without UIDL fails closed with a clear error", async t => {
 muteInboundLogs(t); const f = await fixture(t, { noUidl: true });
 await f.poll(new Date());
 const row = f.sql.prepare("SELECT last_error FROM external_accounts").get();
 assert.equal(row.last_error, "POP3 server does not support UIDL and cannot be polled");
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
 assert.equal(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor, null);
});

test("authentication failure is sanitized and exponential backoff suppresses a repeat connection; success clears it", async t => {
 muteInboundLogs(t); const f = await fixture(t, { failAuth: true }); const at = new Date(); await f.poll(at);
 const row = f.sql.prepare("SELECT last_error FROM external_accounts").get(); assert.equal(row.last_error, "Authentication failed");
 assert.ok(!row.last_error.includes(PASSWORD)); assert.ok(!row.last_error.includes("leaked payload"));
 const connections = f.server.state.connections;
 await f.poll(new Date(at.getTime() + 61_000)); assert.equal(f.server.state.connections, connections, "backoff avoided an immediate retry");
 f.server.state.failAuth = false; await f.poll(new Date(at.getTime() + 121_000));
 assert.equal(f.sql.prepare("SELECT last_error FROM external_accounts").get().last_error, null);
});

test("a source-identity change resets the cursor; stored mail dedups on refetch", async t => {
 muteInboundLogs(t); const f = await fixture(t); const at = new Date(); await f.poll(at);
 f.sql.prepare("UPDATE external_accounts SET host = '127.0.0.1', sync_cursor = NULL, last_synced_at = NULL, last_error = NULL").run();
 const result = await f.poll(new Date(at.getTime() + 61_000));
 assert.deepEqual(result, { accounts: 1 });
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1, "reset refetched but deduplicated");
 assert.deepEqual(JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor).uidls, [await m.pop3UidlHash("uidl-one")]);
});

test("an expired claim cannot store fetched mail or advance the cursor", async t => {
 muteInboundLogs(t); const f = await fixture(t, { pauseRetr: true });
 f.sql.prepare("UPDATE external_accounts SET id = 'expired-lease-account'").run();
 const polling = f.poll(new Date());
 const deadline = Date.now() + 2_000;
 while (!f.server.state.resumeRetr && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
 assert.ok(f.server.state.resumeRetr, "poll reached the paused RETR");
 f.sql.prepare("UPDATE external_accounts SET poll_claim_until = ? WHERE id = 'expired-lease-account'").run(Math.floor(Date.now() / 1000) - 1);
 f.server.state.resumeRetr(); await polling;
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
 const row = f.sql.prepare("SELECT sync_cursor, poll_claim_token FROM external_accounts").get();
 assert.equal(row.sync_cursor, null); assert.equal(row.poll_claim_token, null);
});

test("workerd runtime is explicitly gated from the Node TCP poller", async t => {
 const f = await fixture(t); f.env.MAILFLARE_RUNTIME = "workerd";
 assert.deepEqual(await f.poll(new Date()), { skipped: "runtime_unsupported", accounts: 0 }); assert.equal(f.server.state.connections, 0);
});
