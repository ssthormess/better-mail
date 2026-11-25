import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-imap-protocol-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: { contents: 'export { parseImapCommand, dispatchImapCommand, loginResult, quoteImapLiteral } from "./server/runtime/imap-protocol.ts";', resolveDir: root, sourcefile: "imap-entry.ts" },
	outfile: join(outDir, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
});
const { parseImapCommand, dispatchImapCommand, loginResult, quoteImapLiteral } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

test("parses tagged commands and quoted arguments with escaped quotes", () => {
	assert.deepEqual(parseImapCommand('A1 LOGIN "alice@example.test" "p\\\"ass"'), { tag: "A1", verb: "LOGIN", args: ["alice@example.test", 'p"ass'] });
	assert.deepEqual(parseImapCommand("tag-2 nOoP"), { tag: "tag-2", verb: "NOOP", args: [] });
	assert.equal(parseImapCommand('A1 LOGIN "unterminated'), null);
	assert.equal(parseImapCommand('A1 LOGIN "bad"trailing'), null);
	assert.equal(parseImapCommand(`A1 LOGIN user ${quoteImapLiteral('pass with "quote')}`).args[1], 'pass with "quote');
});

test("dispatches supported commands and sends valid unimplemented commands an honest NO", async () => {
	assert.match((await dispatchImapCommand("not-authenticated", parseImapCommand("A CAPABILITY"))).response, /IMAP4rev1/);
	assert.match((await dispatchImapCommand("not-authenticated", parseImapCommand("A NOOP"))).response, /A OK NOOP/);
	assert.match((await dispatchImapCommand("not-authenticated", parseImapCommand("A ID NIL"))).response, /Mailflare/);
	assert.match((await dispatchImapCommand("not-authenticated", parseImapCommand("A SELECT INBOX"))).response, /A BAD/);
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand("A FETCH 1 ALL"))).response, /A NO Not implemented yet/);
	// The mailbox verbs need a database, so without a backend they answer NO instead of guessing.
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand("A SELECT INBOX"))).response, /A NO Mailbox data unavailable/);
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand('A LIST "" "*"'))).response, /A NO Mailbox data unavailable/);
	assert.equal((await dispatchImapCommand("not-authenticated", parseImapCommand("A LOGIN user pass"))).login.password, "pass");
	assert.equal((await dispatchImapCommand("not-authenticated", parseImapCommand("A LOGIN user"))).response, "A BAD LOGIN requires username and password\r\n");
	assert.match((await dispatchImapCommand("not-authenticated", parseImapCommand("A LOGOUT"))).response, /A OK LOGOUT/);
});

test("LOGIN transitions state only after successful app-password authentication", async () => {
	assert.deepEqual(loginResult("A", true), { response: "A OK LOGIN completed\r\n", state: "authenticated" });
	assert.deepEqual(loginResult("A", false), { response: "A NO Authentication failed\r\n" });
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand("B LOGIN user pass"))).response, /B BAD/);
});
