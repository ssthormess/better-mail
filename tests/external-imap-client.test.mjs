import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "mailflare-external-imap-"));
after(() => rmSync(out, { recursive: true, force: true }));
await build({ stdin: { contents: 'export { fetchImap } from "./src/lib/external-accounts/imap-client.ts";', resolveDir: root }, outfile: join(out, "client.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { fetchImap } = await import(pathToFileURL(join(out, "client.mjs")));

function fakeServer({ authFailure = false } = {}) {
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
    if (command.startsWith("LOGIN ") && authFailure) socket.write(`${tag} NO [AUTHENTICATIONFAILED] nope\r\n`);
    else if (command.startsWith("EXAMINE")) socket.write(`* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY 42] stable\r\n${tag} OK selected\r\n`);
    else if (command.startsWith("UID SEARCH")) socket.write(`* SEARCH 3\r\n${tag} OK searched\r\n`);
    else if (command.startsWith("UID FETCH")) {
     const raw = Buffer.from("From: sender@example.net\r\nSubject: hi\r\n\r\nBody\r\n", "utf8");
     socket.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 3 BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK fetched\r\n`)]));
    } else socket.write(`${tag} OK done\r\n`);
   }
  });
 });
 return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, commands, port: server.address().port })));
}

test("TLS none fetches UID RFC822 bytes and reports UIDVALIDITY", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close());
 const result = await fetchImap({ host: "127.0.0.1", port: fixture.port, tlsMode: "none", username: "u", password: "secret" }, null, 50, 1024);
 assert.equal(result.uidValidity, 42);
 assert.equal(result.lastUid, 3);
 assert.equal(result.messages.length, 1);
 assert.equal(result.messages[0].raw.toString(), "From: sender@example.net\r\nSubject: hi\r\n\r\nBody\r\n");
 assert.ok(fixture.commands.some(line => line.includes("UID SEARCH UID 1:*")));
 assert.ok(fixture.commands.some(line => line.includes("UID FETCH 3 (UID BODY.PEEK[])")));
 assert.ok(fixture.commands.at(-1).endsWith("LOGOUT"));
});

test("authentication failures have a fixed error and never expose server response data", async t => {
 const fixture = await fakeServer({ authFailure: true }); t.after(() => fixture.server.close());
 await assert.rejects(fetchImap({ host: "127.0.0.1", port: fixture.port, tlsMode: "none", username: "u", password: "never-log" }, null, 50, 1024), { message: "authentication_failed" });
});

test("initial fetch honors the message byte cap", async t => {
 const fixture = await fakeServer(); t.after(() => fixture.server.close());
 await assert.rejects(fetchImap({ host: "127.0.0.1", port: fixture.port, tlsMode: "none", username: "u", password: "p" }, null, 50, 4), { message: "message_too_large" });
});
