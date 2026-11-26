import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
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

function makeServer({ uidValidity = 77, messages = new Map([[1, "From: sender@outside.test\r\nTo: me@one.test\r\nSubject: imported\r\nMessage-ID: <same@outside.test>\r\nDate: Thu, 19 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nhello\r\n"]]), failAuth = false, pauseFetch = false, pauseExamine = false } = {}) {
 const state = { uidValidity, messages, failAuth, pauseFetch, pauseExamine, resumeFetch: null, commands: [], connections: 0 };
 const server = createServer(socket => {
  state.connections++;
  socket.on("error", () => {}); // Oversized bodies intentionally close the client before the server writes the literal.
  socket.write("* OK IMAP fake\r\n");
  let buffer = "";
  socket.on("data", chunk => {
   buffer += chunk.toString("binary"); let end;
   while ((end = buffer.indexOf("\r\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const [tag, ...parts] = line.split(" "); const command = parts.join(" "); state.commands.push(command);
    if (command.startsWith("LOGIN") && state.failAuth) socket.write(`${tag} NO [AUTHENTICATIONFAILED] leaked server payload ${PASSWORD}\r\n`);
    else if (command.startsWith("EXAMINE")) {
     const reply = () => socket.write(`* 2 EXPUNGE\r\n* OK [UIDVALIDITY ${state.uidValidity}] valid\r\n* OK [UIDNEXT ${Math.max(0, ...state.messages.keys()) + 1}] next\r\n${tag} OK examined\r\n`);
     if (state.pauseExamine) setTimeout(reply, 500); else reply();
    }
    else if (command.startsWith("UID SEARCH")) {
     const [start, end] = command.match(/UID (\d+):(\d+)/)?.slice(1).map(Number) ?? [1, 0xffff_ffff];
     const uids = [...state.messages.keys()].filter(uid => uid >= start && uid <= end).sort((a, b) => a - b);
     socket.write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK searched\r\n`);
    } else if (command.startsWith("UID FETCH")) {
     const uid = Number(command.match(/UID FETCH (\d+)/)?.[1]); const raw = Buffer.from(state.messages.get(uid));
     if (command.includes("RFC822.SIZE")) { socket.write(`* 1 FETCH (UID ${uid} RFC822.SIZE ${raw.length})\r\n${tag} OK size\r\n`); continue; }
     const reply = () => socket.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK fetched\r\n`)]));
     if (state.pauseFetch) state.resumeFetch = reply; else reply();
    } else socket.write(`${tag} OK done\r\n`);
   }
  });
 });
 return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ state, server, port: server.address().port })));
}

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
 const insert = (id = "account", { enabled = 1, cursor = null, protocol = "imap" } = {}) => sql.prepare(`INSERT INTO external_accounts
  (id, mailbox_id, user_id, protocol, host, port, tls_mode, username, password_encrypted, enabled, last_synced_at, last_error, sync_cursor, created_at, updated_at)
  VALUES (?, 'mailbox', 'owner', ?, ?, ?, 'none', ?, ?, ?, NULL, NULL, ?, 1, 1)`).run(id, protocol, "127.0.0.1", server.port, id, sealed, enabled, cursor);
 insert();
 env.REALTIME = { getByName: () => ({ fetch: async () => { effects.realtime++; return new Response(null, { status: 204 }); } }) };
 return { env, sql, database, server, objects, effects, insert, poll: now => m.pollExternalImapAccounts(env, now) };
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
 const account = f.sql.prepare("SELECT sync_cursor, last_synced_at, last_error FROM external_accounts WHERE id='account'").get();
 assert.deepEqual(JSON.parse(account.sync_cursor), { uidValidity: 77, lastUid: 1 }); assert.ok(account.last_synced_at); assert.equal(account.last_error, null);
 const messages = f.sql.prepare("SELECT mailbox_id, direction, subject, provider_message_id, raw_r2_key FROM messages").all();
 assert.equal(messages.length, 1); assert.equal(messages[0].mailbox_id, "mailbox"); assert.equal(messages[0].direction, "inbound"); assert.equal(messages[0].subject, "imported");
 assert.equal(messages[0].provider_message_id, "<same@outside.test>"); assert.ok(f.objects.has(messages[0].raw_r2_key));
 assert.equal(f.effects.realtime, 0, "notifications suppressed"); assert.equal(f.effects.autoReply, 0, "auto-replies suppressed"); assert.equal(f.effects.webhook, 0, "webhooks suppressed");
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM webhook_deliveries").get().n, 0);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM auto_reply_deliveries").get().n, 0);
});

test("historical intake stores calendar mail without creating invites/reminders or spam reputation observations", async t => {
 muteInboundLogs(t);
 const message = [
  "From: organizer@outside.test", "To: me@one.test", "Subject: old invite", "Message-ID: <old-invite@outside.test>",
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="calendar-boundary"', "", "--calendar-boundary",
  "Content-Type: text/plain; charset=utf-8", "", "Please join this old meeting.", "--calendar-boundary",
  'Content-Type: text/calendar; method=REQUEST; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', "",
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:old-invite@example.test",
  "DTSTART:20261104T170000Z", "DTEND:20261104T180000Z", "SUMMARY:Old meeting",
  "ORGANIZER:mailto:organizer@outside.test", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@one.test", "BEGIN:VALARM",
  "TRIGGER:-PT15M", "ACTION:DISPLAY", "DESCRIPTION:Old meeting", "END:VALARM", "END:VEVENT", "END:VCALENDAR",
  "--calendar-boundary--", "",
 ].join("\r\n");
 const f = await fixture(t, { messages: new Map([[1, message]]) }); await f.poll(new Date());
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM calendar_events").get().n, 0);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM spam_reputation").get().n, 0);
 assert.equal(f.effects.realtime, 0); assert.equal(f.effects.autoReply, 0); assert.equal(f.effects.webhook, 0);
});

test("a permanently oversized UID is recorded and skipped without blocking later messages", async t => {
 muteInboundLogs(t);
 const small1 = "From: a@outside.test\r\nTo: me@one.test\r\nSubject: before\r\nMessage-ID: <before@outside.test>\r\n\r\nsmall\r\n";
 const small3 = "From: c@outside.test\r\nTo: me@one.test\r\nSubject: after\r\nMessage-ID: <after@outside.test>\r\n\r\nafter\r\n";
 const messages = new Map([[1, small1], [2, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)], [3, small3]]);
 const f = await fixture(t, { messages }); const at = new Date(); await f.poll(at);
 const firstSubjects = f.sql.prepare("SELECT subject FROM messages ORDER BY subject").all().map(row => row.subject);
 assert.deepEqual(firstSubjects, ["after", "before"], "valid messages were stored and UID 2 was skipped in sequence");
 const firstState = f.sql.prepare("SELECT sync_cursor, last_error FROM external_accounts").get();
 assert.deepEqual(JSON.parse(firstState.sync_cursor), { uidValidity: 77, lastUid: 3, skippedUids: [2] });
 assert.match(firstState.last_error, /oversized messages skipped/i);
 await f.poll(new Date(at.getTime() + 61_000));
 const subjects = f.sql.prepare("SELECT subject FROM messages ORDER BY subject").all().map(row => row.subject);
 assert.deepEqual(subjects, ["after", "before"], "the next poll continued at UID 3 instead of retrying UID 2");
 const state = f.sql.prepare("SELECT sync_cursor, last_error FROM external_accounts").get();
 assert.deepEqual(JSON.parse(state.sync_cursor), { uidValidity: 77, lastUid: 3, skippedUids: [2] });
 assert.match(state.last_error, /oversized messages skipped/i);
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
 assert.deepEqual(retried, { accounts: 1 }, `retry should run after backoff, got state ${JSON.stringify(f.sql.prepare("SELECT last_synced_at, last_error, updated_at FROM external_accounts").get())}`);
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
 assert.deepEqual(JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts").get().sync_cursor), { uidValidity: 77, lastUid: 1 });
});

test("a timed-out replay PUT never deletes a content-addressed raw object already referenced by a message", async t => {
 muteInboundLogs(t); const f = await fixture(t); const at = new Date(); await f.poll(at);
 const referencedKey = f.sql.prepare("SELECT raw_r2_key FROM messages").get().raw_r2_key;
 assert.ok(f.objects.has(referencedKey));
 f.sql.prepare("UPDATE external_accounts SET id = 'timeout-replay-account', sync_cursor = NULL, last_synced_at = NULL WHERE id = 'account'").run();
 f.sql.prepare("INSERT INTO mailboxes (id,user_id,domain_id,local_part,created_at) VALUES ('mailbox2','owner','domain','alt',1)").run();
 f.sql.prepare(`INSERT INTO external_accounts (id,mailbox_id,user_id,protocol,host,port,tls_mode,username,password_encrypted,enabled,last_synced_at,last_error,sync_cursor,created_at,updated_at)
  SELECT 'healthy','mailbox2',user_id,protocol,host,port,tls_mode,'healthy',password_encrypted,enabled,?,NULL,NULL,created_at,updated_at FROM external_accounts WHERE id='timeout-replay-account'`).run(Math.floor(at.getTime() / 1000));
 const originalPut = f.env.BUCKET.put; let putCalls = 0;
 f.env.BUCKET.put = async (key, value, options) => putCalls++ === 0 ? new Promise(() => {}) : originalPut(key, value, options);
 const started = Date.now(); const result = await f.poll(new Date(at.getTime() + 61_000));
 assert.ok(Date.now() - started < 7_000, "a stalled PUT must not hold the poll tick indefinitely");
 assert.deepEqual(result, { accounts: 1 }, "the next account in the tick must still be polled");
 assert.equal(f.objects.has(referencedKey), true, "timeout cleanup must not delete an already-referenced object");
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages WHERE raw_r2_key = ?").get(referencedKey).n, 1);
 assert.deepEqual(JSON.parse(f.sql.prepare("SELECT sync_cursor FROM external_accounts WHERE id='healthy'").get().sync_cursor), { uidValidity: 77, lastUid: 1 });
});

test("UIDVALIDITY reset re-fetches old UIDs but mailbox-scoped raw hash deduplicates stored mail", async t => {
 muteInboundLogs(t); const first = await fixture(t); const at = new Date(); await first.poll(at);
 first.server.state.uidValidity = 78; await first.poll(new Date(at.getTime() + 61_000));
 assert.ok(first.server.state.commands.includes("UID SEARCH UID 1:1"));
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

test("overlapping scheduler ticks are skipped across a slow in-flight poll", async t => {
 muteInboundLogs(t); const f = await fixture(t, { pauseFetch: true });
 const first = f.poll(new Date());
 const deadline = Date.now() + 2_000;
 while (!f.server.state.resumeFetch && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
 assert.ok(f.server.state.resumeFetch, "first poll reached FETCH");
 assert.deepEqual(await f.poll(new Date()), { skipped: "already_running", accounts: 0 });
 assert.equal(f.server.state.connections, 1);
 f.server.state.resumeFetch();
 await first;
});

test("an expired claim cannot store fetched mail or advance the cursor", async t => {
 muteInboundLogs(t); const f = await fixture(t, { pauseFetch: true });
 f.sql.prepare("UPDATE external_accounts SET id = 'expired-lease-account'").run();
 const polling = f.poll(new Date());
 const deadline = Date.now() + 2_000;
 while (!f.server.state.resumeFetch && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
 assert.ok(f.server.state.resumeFetch, "poll reached the paused body FETCH");
 f.sql.prepare("UPDATE external_accounts SET poll_claim_until = ? WHERE id = 'expired-lease-account'").run(Math.floor(Date.now() / 1000) - 1);
 f.server.state.resumeFetch(); await polling;
 assert.equal(f.sql.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
 const row = f.sql.prepare("SELECT sync_cursor, poll_claim_token FROM external_accounts").get();
 assert.equal(row.sync_cursor, null); assert.equal(row.poll_claim_token, null);
});

test("two independent Node processes acquire only one database-backed account lease", async t => {
 const databasePath = join(out, "claim-fence.db");
 const f = await fixture(t, { databasePath, messages: new Map(), pauseExamine: true });
 const bundleUrl = pathToFileURL(join(out, "entry.mjs")).href;
 const runChild = () => new Promise((resolve, reject) => {
  const source = `const m=await import(${JSON.stringify(bundleUrl)});const db=new m.SqliteDatabase(process.env.TEST_DB);const env={DB:db,MAILFLARE_RUNTIME:"node",EXTERNAL_FETCH_ALLOW_PRIVATE:"1",MAILFLARE_ENCRYPTION_KEY:process.env.TEST_KEY,BUCKET:{}};try{console.log(JSON.stringify(await m.pollExternalImapAccounts(env)));}catch(e){console.error(e.message);process.exitCode=1}finally{db.db.close()}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, TEST_DB: databasePath, TEST_KEY: KEY }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `child exited ${code}`)));
 });
 const results = await Promise.all([runChild(), runChild()]);
 assert.deepEqual(results.map(result => result.accounts).sort(), [0, 1]);
 assert.equal(f.server.state.connections, 1);
 const row = f.sql.prepare("SELECT poll_claim_token, poll_claim_until FROM external_accounts").get();
 assert.equal(row.poll_claim_token, null); assert.equal(row.poll_claim_until, null);
});

test("workerd runtime is explicitly gated from the Node TCP poller", async t => {
 const f = await fixture(t); f.env.MAILFLARE_RUNTIME = "workerd";
 assert.deepEqual(await f.poll(new Date()), { skipped: "runtime_unsupported", accounts: 0 }); assert.equal(f.server.state.connections, 0);
});
