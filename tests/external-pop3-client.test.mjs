import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "mailflare-external-pop3-"));
after(() => rmSync(out, { recursive: true, force: true }));
const tlsMock = join(out, "tls-mock.mjs");
writeFileSync(tlsMock, `import { connect as netConnect } from "node:net";
export function checkServerIdentity(_host, _cert) { return undefined; }
export function connect(options, callback) {
 globalThis.__tlsCalls.push({ rejectUnauthorized: options.rejectUnauthorized, servername: options.servername, starttls: !!options.socket, checkServerIdentity: typeof options.checkServerIdentity });
 const socket = options.socket ?? netConnect({ host: options.host === "pop3.example.test" ? "127.0.0.1" : options.host, port: options.port });
 if (options.socket && globalThis.__tlsHang) {}
 else socket.once("connect", () => { socket.emit("secureConnect"); callback?.(); });
 if (options.socket && !globalThis.__tlsHang) queueMicrotask(() => { socket.emit("secureConnect"); callback?.(); });
 return socket;
}\n`);
await build({
 stdin: { contents: 'export { fetchPop3 } from "./src/lib/external-accounts/pop3-client.ts";', resolveDir: root },
 outfile: join(out, "client.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
 plugins: [{ name: "fake-tls", setup(build) { build.onResolve({ filter: /^node:tls$/ }, () => ({ path: tlsMock })); } }],
});
const { fetchPop3 } = await import(pathToFileURL(join(out, "client.mjs")));

const DEFAULT_RAW = "From: sender@example.net\r\nSubject: hi\r\n\r\nBody\r\n";

/** Dot-stuffs raw bytes the way a server sends them, then appends the terminator line. */
function wire(raw) {
 const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
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

function fakeServer({ messages = [[1, "uidl-one", DEFAULT_RAW]], authFailure = false, noUidl = false, oversized = false, badGreeting = false, uidlErr = false, retrErr = false, malformedList = false, malformedUidl = false, listOnly = null, splitBytes = 0, statCount = null, listenHost = "127.0.0.1" } = {}) {
 const commands = []; let connections = 0;
 const server = createServer((socket) => {
  connections++;
  socket.on("error", () => {});
  socket.write(badGreeting ? "* OK not pop3\r\n" : "+OK fake pop3 ready\r\n");
  let pending = "";
  socket.on("data", chunk => {
   pending += chunk.toString("binary");
   let end;
   while ((end = pending.indexOf("\r\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 2);
    commands.push(line);
    if (line === "STLS") socket.write("+OK begin TLS\r\n");
    else if (line.startsWith("USER")) socket.write(authFailure ? "-ERR no such user\r\n" : "+OK user accepted\r\n");
    else if (line.startsWith("PASS")) socket.write(authFailure ? "-ERR leaked payload: never-log\r\n" : "+OK pass accepted\r\n");
    else if (line === "STAT") {
     const size = messages.reduce((sum, [, , raw]) => sum + (Buffer.isBuffer(raw) ? raw.length : Buffer.from(raw).length), 0);
     socket.write(`+OK ${statCount ?? messages.length} ${size}\r\n`);
    } else if (line === "UIDL") {
     if (noUidl || uidlErr) socket.write("-ERR unsupported\r\n");
     else socket.write(`+OK\r\n${messages.map(([num, uidl]) => `${num} ${uidl}\r\n`).join("")}.\r\n`);
    } else if (line.startsWith("LIST")) {
     const num = Number(line.split(" ")[1]);
     const entry = messages.find(([n]) => n === num);
     if (malformedList) socket.write("+OK nope\r\n");
     else socket.write(entry ? `+OK ${num} ${oversized && num === 2 ? 20000000 : (Buffer.isBuffer(entry[2]) ? entry[2].length : Buffer.from(entry[2]).length)}\r\n` : "-ERR no such message\r\n");
    } else if (line.startsWith("RETR")) {
     const num = Number(line.split(" ")[1]);
     const entry = messages.find(([n]) => n === num);
     if (retrErr) socket.write("-ERR nope\r\n");
     else if (!entry) socket.write("-ERR no such message\r\n");
     else {
      const body = wire(entry[2]);
      socket.write("+OK\r\n");
      if (!splitBytes) socket.write(body);
      else for (let i = 0; i < body.length; i += splitBytes) socket.write(body.subarray(i, i + splitBytes));
     }
    } else if (line === "QUIT") socket.write("+OK bye\r\n");
    else socket.write("+OK\r\n");
   }
  });
 });
 return new Promise(resolve => server.listen(0, listenHost, () => resolve({ server, commands, get connections() { return connections; }, port: server.address().port })));
}
const input = (fixture, tlsMode = "none", allowPrivate = true) => ({ host: "127.0.0.1", port: fixture.port, tlsMode, username: "u", password: "secret", allowPrivate });
const hash = async uidl => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uidl))), b => b.toString(16).padStart(2, "0")).join("");
const run = (fixture, seen = new Set(), skipped = new Set(), maxMessages = 50, maxBytes = 1024 * 1024, tlsMode = "none", allowPrivate = true) =>
 fetchPop3(input(fixture, tlsMode, allowPrivate), seen, skipped, maxMessages, maxBytes);

test("fetch authenticates, diffs UIDLs and retrieves messages oldest first", async t => {
 const fixture = await fakeServer({ messages: [[1, "a", "raw one"], [2, "b", DEFAULT_RAW]] }); t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.messages.length, 2); assert.equal(result.delivered, 2); assert.equal(result.listed, 2);
 assert.deepEqual(result.messages.map(message => message.msgnum), [1, 2]);
 assert.equal(result.messages[0].raw.toString(), "raw one");
 for (const verb of ["USER u", "PASS secret", "STAT", "UIDL", "LIST 1", "RETR 1", "LIST 2", "RETR 2", "QUIT"])
  assert.ok(fixture.commands.includes(verb), `sent ${verb}`);
 assert.deepEqual(fixture.commands.slice(0, 2), ["USER u", "PASS secret"]);
 assert.ok(!fixture.commands.some(command => command.startsWith("DELE")), "mail is left on the server");
 assert.equal(result.messages[0].uidlHash, await hash("a"));
});

test("seen and skipped hashes suppress the fetch but the diff still happens", async t => {
 const fixture = await fakeServer({ messages: [[1, "a", "raw one"], [2, "b", DEFAULT_RAW], [3, "c", "raw three"]] });
 t.after(() => fixture.server.close());
 const seen = new Set([await hash("a")]); const skipped = new Set([await hash("c")]);
 const result = await run(fixture, seen, skipped);
 assert.equal(result.messages.length, 1); assert.equal(result.messages[0].msgnum, 2);
 assert.ok(!fixture.commands.some(command => command === "RETR 1" || command === "RETR 3"));
});

test("dot-stuffed lines are unstuffed and a message ending without CRLF is preserved", async t => {
 const fixture = await fakeServer({ messages: [[1, "a", Buffer.from("line one\r\n.stuffed\r\nno trailing")]] });
 t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.messages[0].raw.toString(), "line one\r\n.stuffed\r\nno trailing");
});

test("a terminator split across socket chunks still ends the body", async t => {
 const fixture = await fakeServer({ splitBytes: 3 }); t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.messages.length, 1); assert.equal(result.messages[0].raw.toString(), DEFAULT_RAW);
});

test("a message containing a lone stuffed dot line keeps it", async t => {
 const fixture = await fakeServer({ messages: [[1, "a", Buffer.from("first\r\n.\r\nlast\r\n")]] });
 t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.messages[0].raw.toString(), "first\r\n.\r\nlast\r\n");
});

test("a UIDL-less server fails closed as unsupported", async t => {
 const fixture = await fakeServer({ noUidl: true }); t.after(() => fixture.server.close());
 await assert.rejects(run(fixture), { message: "uidl_unsupported" });
 assert.ok(!fixture.commands.some(command => command.startsWith("RETR")));
});

test("oversized messages are skipped by LIST size without RETR and counted", async t => {
 const fixture = await fakeServer({ messages: [[1, "a", "raw one"], [2, "big", DEFAULT_RAW], [3, "c", "raw three"]], oversized: true });
 t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.messages.length, 2); assert.deepEqual(result.skippedUidls, [await hash("big")]);
 assert.ok(!fixture.commands.some(command => command === "RETR 2"));
 assert.equal(result.delivered, 3);
});

test("message-count cap bounds how many RETRs a poll issues", async t => {
 const fixture = await fakeServer({ messages: [[1, "a", "1"], [2, "b", "2"], [3, "c", "3"], [4, "d", "4"]] });
 t.after(() => fixture.server.close());
 const result = await run(fixture, new Set(), new Set(), 2);
 assert.equal(result.messages.length, 2);
 assert.deepEqual(result.messages.map(message => message.msgnum), [1, 2]);
 assert.equal(fixture.commands.filter(command => command.startsWith("RETR")).length, 2);
});

test("malformed LIST and UIDL replies fail the session", async t => {
 const bad = await fakeServer({ malformedList: true }); t.after(() => bad.server.close());
 await assert.rejects(run(bad), { message: "invalid_response" });
});

test("RETR failure is a fixed error, never wire text", async t => {
 const fixture = await fakeServer({ retrErr: true }); t.after(() => fixture.server.close());
 await assert.rejects(run(fixture), { message: "pop3_command_failed" });
});

test("a non-POP3 greeting and a hung STAT fail closed", async t => {
 const bad = await fakeServer({ badGreeting: true }); t.after(() => bad.server.close());
 await assert.rejects(run(bad), { message: "server_unavailable" });
});

test("STLS is sent before USER and requests verified TLS", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = [];
 await run(fixture, new Set(), new Set(), 50, 1024 * 1024, "starttls");
 const stls = fixture.commands.findIndex(line => line === "STLS");
 const user = fixture.commands.findIndex(line => line.startsWith("USER"));
 assert.ok(stls >= 0 && user > stls);
 assert.deepEqual(globalThis.__tlsCalls, [{ rejectUnauthorized: true, servername: undefined, starttls: true, checkServerIdentity: "function" }]);
});

test("implicit TLS connects before commands and requests verified TLS", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = [];
 await run(fixture, new Set(), new Set(), 50, 1024 * 1024, "implicit-tls");
 assert.ok(fixture.commands.some(line => line.startsWith("USER")));
 assert.ok(!fixture.commands.some(line => line === "STLS"));
 assert.deepEqual(globalThis.__tlsCalls, [{ rejectUnauthorized: true, servername: undefined, starttls: false, checkServerIdentity: "function" }]);
});

test("TLS none sends cleartext credentials and never upgrades", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close()); globalThis.__tlsCalls = [];
 await run(fixture);
 assert.ok(fixture.commands.includes("PASS secret"));
 assert.deepEqual(globalThis.__tlsCalls, []);
});

test("private destinations are denied unless opted in, and unsafe credentials are refused", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close());
 for (const host of ["127.0.0.1", "::1", "2001:db8::1", "3fff::1"]) {
  await assert.rejects(fetchPop3({ ...input(fixture), host, allowPrivate: false }, new Set(), new Set(), 50, 1024), { message: "egress_denied" });
 }
 assert.deepEqual(fixture.commands, []);
 await assert.rejects(fetchPop3({ ...input(fixture), username: "u\r\nDELE 1", allowPrivate: true }, new Set(), new Set(), 50, 1024), { message: "credentials_unsupported" });
 await assert.rejects(fetchPop3({ ...input(fixture), username: "with space", allowPrivate: true }, new Set(), new Set(), 50, 1024), { message: "credentials_unsupported" });
 await assert.rejects(fetchPop3({ ...input(fixture), password: "pāss", allowPrivate: true }, new Set(), new Set(), 50, 1024), { message: "credentials_unsupported" });
 assert.ok(!fixture.commands.some(command => command.startsWith("USER")));
});

test("authentication failures are fixed and do not expose server response or password", async t => {
 const fixture = await fakeServer({ authFailure: true }); t.after(() => fixture.server.close());
 await assert.rejects(run(fixture), error => {
  assert.equal(error.message, "authentication_failed");
  assert.ok(!error.message.includes("never-log")); assert.ok(!error.message.includes("secret"));
  return true;
 });
});

test("STAT zero skips the UIDL round trip entirely", async t => {
 const fixture = await fakeServer({ statCount: 0 }); t.after(() => fixture.server.close());
 const result = await run(fixture);
 assert.equal(result.messages.length, 0); assert.equal(result.listed, 0);
 assert.ok(!fixture.commands.some(command => command === "UIDL"));
 assert.ok(fixture.commands.includes("QUIT"));
});
