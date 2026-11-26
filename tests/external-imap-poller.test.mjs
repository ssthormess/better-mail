import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(root, "node_modules", "external-imap-poller-test-"));
after(() => rmSync(out, { recursive: true, force: true }));
await build({
 stdin: { contents: `
  export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
  export { applyMigrations } from "./server/runtime/migrate.ts";
  export { pollExternalImapAccounts } from "./src/lib/external-accounts/poller.ts";
  export { encryptSecret } from "./src/lib/external-accounts/crypto.ts";
 `, resolveDir: root, sourcefile: "external-imap-poller-test.ts" },
 outfile: join(out, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.json"), packages: "external",
 alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" }, logLevel: "silent",
});
const m = await import(pathToFileURL(join(out, "entry.mjs")));
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const PASSWORD = "poller-password-secret";

function makeServer({ uidValidity = 77, messages = new Map([[1, "From: sender@outside.test\r\nTo: me@one.test\r\nSubject: imported\r\nMessage-ID: <same@outside.test>\r\nDate: Thu, 19 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nhello\r\n"]]), failAuth = false } = {}) {
 const state = { uidValidity, messages, failAuth, commands: [], connections: 0 };
 const server = createServer(socket => {
  state.connections++;
  socket.write("* OK IMAP fake\r\n");
  let buffer = "";
  socket.on("data", chunk => {
   buffer += chunk.toString("binary"); let end;
   while ((end = buffer.indexOf("\r\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const [tag, ...parts] = line.split(" "); const command = parts.join(" "); state.commands.push(command);
    if (command.startsWith("LOGIN") && state.failAuth) socket.write(`${tag} NO [AUTHENTICATIONFAILED] leaked server payload ${PASSWORD}\r\n`);
    else if (command.startsWith("EXAMINE")) socket.write(`* 2 EXPUNGE\r\n* OK [UIDVALIDITY ${state.uidValidity}] valid\r\n${tag} OK examined\r\n`);
    else if (command.startsWith("UID SEARCH")) {
     const start = Number(command.match(/UID (\d+):\*/)?.[1] ?? 1);
     const uids = [...state.messages.keys()].filter(uid => uid >= start).sort((a, b) => a - b);
     socket.write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK searched\r\n`);
    } else if (command.startsWith("UID FETCH")) {
     const uid = Number(command.match(/UID FETCH (\d+)/)?.[1]); const raw = Buffer.from(state.messages.get(uid));
     socket.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK fetched\r\n`)]));
    } else socket.write(`${tag} OK done\r\n`);
   }
  });
 });
 return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ state, server, port: server.address().port })));
}

async function fixture(t, options = {}) {
 const server = await makeServer(options); t.after(() => server.server.close());
 const database = new m.SqliteDatabase(":memory:"); t.after(() => database.db.close());
 await m.applyMigrations(database, join(root, "drizzle/migrations"));
 const sql = database.db;
 sql.exec(`
  INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('owner', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
  INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain', 'owner', 'one.test', 'zone', 'active', 1);
  INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox', 'owner', 'domain', 'me', 1);
 `);
 const objects = new Map();
 const env = { DB: database, MAILFLARE_RUNTIME: "node", MAILFLARE_ENCRYPTION_KEY: KEY, BUCKET: {
  put: async (key, value) => objects.set(key, Buffer.from(value)),
  get: async key => objects.has(key) ? { arrayBuffer: async () => { const value = objects.get(key); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); } } : null,
  delete: async key => objects.delete(key),
 } };
 const sealed = await m.encryptSecret(env, PASSWORD);
 const insert = (id = "account", { enabled = 1, cursor = null, protocol = "imap" } = {}) => sql.prepare(`INSERT INTO external_accounts
  (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, last_synced_at, last_error, sync_cursor, created_at, updated_at)
  VALUES (?, 'mailbox', 'owner', ?, ?, ?, 'none', ?, ?, ?, NULL, NULL, ?, 1, 1)`).run(id, protocol, "127.0.0.1", server.port, id, sealed, enabled, cursor);
 insert();
 env.REALTIME = { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) };
 return { env, sql, database, server, objects, insert, poll: now => m.pollExternalImapAccounts(env, now) };
}

const muteInboundLogs = t => {
 for (const method of ["error", "warn", "info", "log"]) t.mock.method(console, method, () => {});
};

test("poll fetches, processes through the canonical inbound consumer and persists cursor and sync state", async t => {
 muteInboundLogs(t); const f = await fixture(t); const now = new Date();
 const result = await f.poll(now); assert.deepEqual(result, { accounts: 1 });
 const account = f.sql.prepare("SELECT sync_cursor, last_synced_at, last_error FROM external_accounts WHERE id='account'").get();
 assert.deepEqual(JSON.parse(account.sync_cursor), { uidValidity: 77, lastUid: 1 }); assert.ok(account.last_synced_at); assert.equal(account.last_error, null);
 const messages = f.sql.prepare("SELECT mailbox_id, direction, subject, provider_message_id, raw_r2_key FROM messages").all();
 assert.equal(messages.length, 1); assert.equal(messages[0].mailbox_id, "mailbox"); assert.equal(messages[0].direction, "inbound"); assert.equal(messages[0].subject, "imported");
 assert.equal(messages[0].provider_message_id, "<same@outside.test>"); assert.ok(f.objects.has(messages[0].raw_r2_key));
});

test("a crash after canonical store but before cursor commit is idempotent on retry", async t => {
 muteInboundLogs(t); const f = await fixture(t); const originalPrepare = f.database.prepare.bind(f.database); let fail = true;
 f.database.prepare = sql => {
  if (fail && /^\s*UPDATE\s+["`]?external_accounts/i.test(sql)) { fail = false; throw new Error(`simulated commit failure; ${PASSWORD}`); }
  return originalPrepare(sql);
 };
 const at = new Date(); await f.poll(at);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.equal(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor, null);
 f.database.prepare = originalPrepare;
 await f.poll(new Date(at.getTime() + 121_000));
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.deepEqual(JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor), { uidValidity: 77, lastUid: 1 });
});

test("UIDVALIDITY reset re-fetches old UIDs but mailbox-scoped raw hash deduplicates stored mail", async t => {
 muteInboundLogs(t); const first = await fixture(t); const at = new Date(); await first.poll(at);
 first.server.state.uidValidity = 78; await first.poll(new Date(at.getTime() + 61_000));
 assert.ok(first.server.state.commands.includes("UID SEARCH UID 1:*"));
 assert.equal(first.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.deepEqual(JSON.parse(first.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor), { uidValidity: 78, lastUid: 1 });
});

test("authentication failure is sanitized and exponential backoff suppresses a repeat connection; success clears it", async t => {
 muteInboundLogs(t); const f = await fixture(t, { failAuth: true }); const at = new Date(); await f.poll(at);
 const row = f.sql.prepare("SELECT last_error FROM external_accounts").get(); assert.equal(row.last_error, "Authentication failed");
 assert.ok(!row.last_error.includes(PASSWORD)); assert.ok(!row.last_error.includes("leaked server payload"));
 const connections = f.server.state.connections;
 await f.poll(new Date(at.getTime() + 61_000)); assert.equal(f.server.state.connections, connections, "backoff avoided an immediate retry");
 f.server.state.failAuth = false; await f.poll(new Date(at.getTime() + 121_000));
 assert.equal(f.sql.prepare("SELECT last_error FROM external_accounts").get().last_error, null);
 const afterSuccess = f.server.state.connections;
 f.server.state.failAuth = true; await f.poll(new Date(at.getTime() + 182_000));
 assert.equal(f.server.state.connections, afterSuccess + 1, "success reset the failure counter to the base one-minute delay");
});

test("disabled and non-IMAP accounts are not dialed", async t => {
 const f = await fixture(t); f.sql.prepare("DELETE FROM external_accounts").run(); f.insert("disabled", { enabled: 0 }); f.insert("pop", { protocol: "pop3" });
 const result = await f.poll(new Date()); assert.deepEqual(result, { accounts: 0 }); assert.equal(f.server.state.connections, 0);
});

test("workerd runtime is explicitly gated from the Node TCP poller", async t => {
 const f = await fixture(t); f.env.MAILFLARE_RUNTIME = "workerd";
 assert.deepEqual(await f.poll(new Date()), { skipped: "runtime_unsupported", accounts: 0 }); assert.equal(f.server.state.connections, 0);
});
