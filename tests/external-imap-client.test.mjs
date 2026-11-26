import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "mailflare-external-imap-"));
after(() => rmSync(out, { recursive: true, force: true }));
const tlsMock = join(out, "tls-mock.mjs");
writeFileSync(tlsMock, `import { connect as netConnect } from "node:net";
export function checkServerIdentity(_host, _cert) { return undefined; }
export function connect(options, callback) {
 globalThis.__tlsCalls.push({ rejectUnauthorized: options.rejectUnauthorized, servername: options.servername, starttls: !!options.socket, checkServerIdentity: typeof options.checkServerIdentity });
 const socket = options.socket ?? netConnect({ host: options.host === "imap.example.test" ? "127.0.0.1" : options.host, port: options.port });
 if (options.socket && !globalThis.__tlsHang) queueMicrotask(() => { socket.emit("secureConnect"); callback?.(); });
 else socket.once("connect", () => { socket.emit("secureConnect"); callback?.(); });
 return socket;
}\n`);
await build({
 stdin: { contents: 'export { fetchImap } from "./src/lib/external-accounts/imap-client.ts";', resolveDir: root },
 outfile: join(out, "client.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
 plugins: [{ name: "fake-tls", setup(build) { build.onResolve({ filter: /^node:tls$/ }, () => ({ path: tlsMock })); } }],
});
const { fetchImap } = await import(pathToFileURL(join(out, "client.mjs")));

function fakeServer({ authFailure = false, uids = [3], uidValidity = 42, style = "body", malformedTag = false, malformedFetch = false, hugeLiteral = false } = {}) {
 const commands = [];
 const server = createServer((socket) => {
  socket.write("* OK test server ready\r\n");
  let pending = "";
  socket.on("data", chunk => {
   pending += chunk.toString("binary");
   let end;
   while ((end = pending.indexOf("\r\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 2);
    const [tag, ...rest] = line.split(" "); const command = rest.join(" "); commands.push(line);
    if (command === "STARTTLS") socket.write(`${tag} OK begin TLS\r\n`);
    else if (command.startsWith("LOGIN ") && authFailure) socket.write(`${tag} NO [AUTHENTICATIONFAILED] password echo: never-log\r\n`);
    else if (command.startsWith("EXAMINE")) socket.write(`* FLAGS (\\Seen)\r\n* 4 EXPUNGE\r\n* OK [UIDVALIDITY ${uidValidity}] stable\r\n${tag} OK selected\r\n`);
    else if (command.startsWith("UID SEARCH")) socket.write(`* SEARCH ${uids.join(" ")}\r\n${tag} ${malformedTag ? "OKAY" : "OK"} searched\r\n`);
    else if (command.startsWith("UID FETCH")) {
     const uid = Number(command.match(/UID FETCH (\d+)/)?.[1]);
     if (hugeLiteral) { socket.write(`* 1 FETCH (UID ${uid} BODY[] {20000000}\r\n`); continue; }
     const body = style === "protocol-looking" ? `* OK [UIDVALIDITY 999] fake\r\n* SEARCH 999\r\n* 2 FETCH (UID 999 BODY[] {3}\r\nfake\r\nA9 OK fake` : `Body ${uid}\r\n`;
     const raw = Buffer.from(`From: sender@example.net\r\nSubject: hi${uid}\r\n\r\n${body}`, "utf8");
     const attr = style === "rfc822" ? "RFC822" : "BODY[]";
     const prefix = style === "uid-after-literal" ? `* 1 FETCH (${attr} {${raw.length}}\r\n` : `* 1 FETCH (UID ${uid} ${attr} {${raw.length}}\r\n`;
     const suffix = style === "uid-after-literal" ? ` UID ${uid}${malformedFetch ? "" : ")"}\r\n${tag} OK fetched\r\n` : `${malformedFetch ? "" : ")"}\r\n${tag} OK fetched\r\n`;
     socket.write(Buffer.concat([Buffer.from(prefix), raw, Buffer.from(suffix)]));
    } else socket.write(`${tag} OK done\r\n`);
   }
  });
 });
 return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, commands, port: server.address().port })));
}
const input = (fixture, tlsMode = "none", allowPrivate = true) => ({ host: "127.0.0.1", port: fixture.port, tlsMode, username: "u", password: "secret", allowPrivate });
const run = (fixture, cursor = null, maxMessages = 50, maxBytes = 1024, tlsMode = "none", allowPrivate = true) => fetchImap(input(fixture, tlsMode, allowPrivate), cursor, maxMessages, maxBytes);

for (const style of ["body", "rfc822", "uid-after-literal", "protocol-looking"]) test(`fetch accepts ${style} literal formatting and untagged noise`, async t => {
 const fixture = await fakeServer({ style }); t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.uidValidity, 42); assert.equal(result.lastUid, 3); assert.equal(result.messages.length, 1);
 const expectedBody = style === "protocol-looking" ? "* OK [UIDVALIDITY 999] fake\r\n* SEARCH 999\r\n* 2 FETCH (UID 999 BODY[] {3}\r\nfake\r\nA9 OK fake" : "Body 3\r\n";
 assert.equal(result.messages[0].raw.toString(), `From: sender@example.net\r\nSubject: hi3\r\n\r\n${expectedBody}`);
 assert.ok(fixture.commands.some(line => line.includes("UID SEARCH UID 1:*")));
 assert.ok(fixture.commands.some(line => line.includes("UID FETCH 3 (UID BODY.PEEK[])")));
 assert.ok(fixture.commands.at(-1).endsWith("LOGOUT"));
});

test("TLS none uses cleartext LOGIN and never attempts an upgrade", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = [];
 await run(fixture, null, 50, 1024, "none");
 assert.ok(fixture.commands.some(line => line.includes('LOGIN "u" "secret"')));
 assert.ok(!fixture.commands.some(line => line.endsWith("STARTTLS")));
 assert.deepEqual(globalThis.__tlsCalls, []);
});

test("a stalled STARTTLS handshake times out and never reaches LOGIN", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = []; globalThis.__tlsHang = true;
 t.after(() => { delete globalThis.__tlsHang; });
 await assert.rejects(run(fixture, null, 50, 1024, "starttls"), { message: "timeout" });
 assert.ok(fixture.commands.some(line => line.endsWith("STARTTLS")));
 assert.ok(!fixture.commands.some(line => line.includes(" LOGIN ")));
});

test("STARTTLS is sent before LOGIN and requests verified TLS", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = [];
 await run(fixture, null, 50, 1024, "starttls");
 const upgrade = fixture.commands.findIndex(line => line.endsWith("STARTTLS"));
 const login = fixture.commands.findIndex(line => line.includes(" LOGIN "));
 assert.ok(upgrade >= 0 && login > upgrade);
 assert.deepEqual(globalThis.__tlsCalls, [{ rejectUnauthorized: true, servername: undefined, starttls: true, checkServerIdentity: "function" }]);
});

test("implicit TLS connects before IMAP commands and requests verified TLS", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = [];
 await run(fixture, null, 50, 1024, "implicit-tls");
 assert.ok(fixture.commands.some(line => line.includes(" LOGIN ")));
 assert.ok(!fixture.commands.some(line => line.endsWith("STARTTLS")));
 assert.deepEqual(globalThis.__tlsCalls, [{ rejectUnauthorized: true, servername: undefined, starttls: false, checkServerIdentity: "function" }]);
});

test("UID search honors cursor UIDVALIDITY and resets to UID 1 on mismatch", async t => {
 const same = await fakeServer({ uids: [4], uidValidity: 42 }); t.after(() => same.server.close());
 await run(same, { uidValidity: 42, lastUid: 3 }); assert.ok(same.commands.some(line => line.includes("UID SEARCH UID 4:*")));
 const changed = await fakeServer({ uids: [1], uidValidity: 43 }); t.after(() => changed.server.close());
 const result = await run(changed, { uidValidity: 42, lastUid: 99 });
 assert.ok(changed.commands.some(line => line.includes("UID SEARCH UID 1:*"))); assert.equal(result.uidValidity, 43);
});

test("message-count and byte caps are enforced", async t => {
 const many = await fakeServer({ uids: Array.from({ length: 4 }, (_, i) => i + 1) }); t.after(() => many.server.close());
 const result = await run(many, null, 2, 1024); assert.equal(result.messages.length, 2);
 assert.equal(many.commands.filter(line => line.includes("UID FETCH")).length, 2);
 const large = await fakeServer(); t.after(() => large.server.close());
 const oversized = await run(large, null, 50, 4);
 assert.deepEqual(oversized.messages, []); assert.equal(oversized.lastUid, 3); assert.equal(oversized.delivered, 1);
});

test("a very large announced literal is skipped without buffering or stalling", async t => {
 const fixture = await fakeServer({ hugeLiteral: true }); t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.lastUid, 3); assert.deepEqual(result.skippedUids, [3]); assert.equal(result.stoppedAfterOversized, true);
});

test("private destinations are denied unless explicitly opted in, and unsafe LOGIN atoms are refused", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close());
 for (const host of ["127.0.0.1", "::1", "2001:db8::1", "3fff::1"]) {
  await assert.rejects(fetchImap({ ...input(fixture), host, allowPrivate: false }, null, 50, 1024), { message: "egress_denied" });
 }
 assert.deepEqual(fixture.commands, []);
 await assert.rejects(fetchImap({ ...input(fixture), username: "u\r\nA9 LOGIN inject", allowPrivate: true }, null, 50, 1024), { message: "credentials_unsupported" });
 await assert.rejects(fetchImap({ ...input(fixture), password: "pāss", allowPrivate: true }, null, 50, 1024), { message: "credentials_unsupported" });
 assert.deepEqual(fixture.commands, []);
});

test("search UIDs below the requested cursor do not regress the high-water mark", async t => {
 const fixture = await fakeServer({ uids: [3, 1] }); t.after(() => fixture.server.close());
 const result = await run(fixture, { uidValidity: 42, lastUid: 4 });
 assert.equal(result.messages.length, 0); assert.equal(result.lastUid, 4);
 assert.ok(fixture.commands.some(line => line.includes("UID SEARCH UID 5:*")));
 assert.ok(!fixture.commands.some(line => line.includes("UID FETCH")));
});

test("malformed status tokens and unclosed FETCH records are rejected", async t => {
 const badStatus = await fakeServer({ malformedTag: true }); t.after(() => badStatus.server.close());
 await assert.rejects(run(badStatus), { message: "invalid_response" });
 const badFetch = await fakeServer({ malformedFetch: true }); t.after(() => badFetch.server.close());
 await assert.rejects(run(badFetch), { message: "invalid_fetch_response" });
});

test("UIDVALIDITY must be canonical positive uint32, and max UID does not overflow the search range", async t => {
 for (const uidValidity of [0, "01", 4_294_967_296]) {
  const fixture = await fakeServer({ uidValidity }); t.after(() => fixture.server.close());
  await assert.rejects(run(fixture), { message: "invalid_mailbox_state" });
 }
 const edge = await fakeServer(); t.after(() => edge.server.close());
 const result = await run(edge, { uidValidity: 42, lastUid: 0xffff_ffff });
 assert.equal(result.lastUid, 0xffff_ffff);
 assert.ok(!edge.commands.some(line => line.includes("UID SEARCH")));
});

test("noncanonical or out-of-range SEARCH UIDs are rejected", async t => {
 for (const uid of [0, "01", 4_294_967_296]) {
  const fixture = await fakeServer({ uids: [uid] }); t.after(() => fixture.server.close());
  await assert.rejects(run(fixture), { message: "invalid_search_response" });
 }
});

test("authentication failures are fixed and do not expose server response or password", async t => {
 const fixture = await fakeServer({ authFailure: true }); t.after(() => fixture.server.close());
 await assert.rejects(run(fixture), error => { assert.equal(error.message, "authentication_failed"); assert.ok(!error.message.includes("never-log")); assert.ok(!error.message.includes("secret")); return true; });
});
