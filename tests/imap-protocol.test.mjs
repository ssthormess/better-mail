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
	stdin: { contents: 'export { parseImapCommand, dispatchImapCommand, loginResult, quoteImapLiteral, encodeModifiedUtf7, decodeModifiedUtf7, parseImapAppendArguments, parseImapDateTime } from "./server/runtime/imap-protocol.ts";', resolveDir: root, sourcefile: "imap-entry.ts" },
	outfile: join(outDir, "entry.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent",
});
const { parseImapCommand, dispatchImapCommand, loginResult, quoteImapLiteral, encodeModifiedUtf7, decodeModifiedUtf7, parseImapAppendArguments, parseImapDateTime } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

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
	// FETCH is a selected-state verb, and writes are still a later slice.
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand("A FETCH 1 FLAGS"))).response, /A BAD No mailbox selected/);
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand("A UID FETCH 1 FLAGS"))).response, /A BAD No mailbox selected/);
	assert.match((await dispatchImapCommand("authenticated", parseImapCommand("A STORE 1 +FLAGS (\\Seen)"))).response, /A NO Not implemented yet/);
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

/**
 * RFC 3501 §5.1.3 modified UTF-7. The vectors are the RFC's own examples (`~peter/mail/`
 * folders, "Entwürfe") plus the cases the codec must not corrupt: a literal `&`, a
 * surrogate pair and a control character.
 */
test("modified UTF-7 encodes and decodes mailbox names", () => {
	assert.equal(encodeModifiedUtf7("INBOX"), "INBOX");
	assert.equal(encodeModifiedUtf7("My Folder"), "My Folder");
	assert.equal(encodeModifiedUtf7("Entwürfe"), "Entw&APw-rfe");
	assert.equal(encodeModifiedUtf7("日本語"), "&ZeVnLIqe-");
	assert.equal(encodeModifiedUtf7("A&B"), "A&-B");
	assert.equal(encodeModifiedUtf7("&"), "&-");
	assert.equal(encodeModifiedUtf7("a😀b"), "a&2D3eAA-b");
	assert.equal(decodeModifiedUtf7("&-"), "&");
	assert.equal(decodeModifiedUtf7("Entw&APw-rfe"), "Entwürfe");
	assert.equal(decodeModifiedUtf7("&ZeVnLIqe-"), "日本語");
	assert.equal(decodeModifiedUtf7("A&-B"), "A&B");
	assert.equal(decodeModifiedUtf7("a&2D3eAA-b"), "a😀b");
	// ASCII names must not move, which is what keeps every earlier LIST/SELECT reply identical.
	for (const name of ["INBOX", "Sent", "My Folder", "sales@example.test/Leads", "mbx1~f~fld1"]) {
		assert.equal(encodeModifiedUtf7(name), name);
		assert.equal(decodeModifiedUtf7(name), name);
	}
	for (const name of ["Entwürfe", "日本語", "A&B", "&", "a😀b", "line\nbreak", "&AMQ-", "Grüße/Ärger"]) {
		assert.equal(decodeModifiedUtf7(encodeModifiedUtf7(name)), name, name);
	}
});

test("modified UTF-7 refuses sequences it cannot decode instead of inventing characters", () => {
	assert.equal(decodeModifiedUtf7("&"), null);
	assert.equal(decodeModifiedUtf7("Entw&APw"), null);
	assert.equal(decodeModifiedUtf7("&A-"), null);
	assert.equal(decodeModifiedUtf7("&A!A-"), null);
	assert.equal(decodeModifiedUtf7("&AAA-"), null);
	assert.equal(decodeModifiedUtf7("&/w-"), null);
});

test("APPEND arguments split into a mailbox, a flag list and an internal date", () => {
	assert.deepEqual(parseImapAppendArguments(["INBOX"]), { name: "INBOX", flags: [], internalDate: null });
	// The command line is split on spaces, so a parenthesized flag list arrives as several tokens.
	assert.deepEqual(parseImapAppendArguments(["INBOX", "(\\Seen", "\\Flagged)"]).flags, ["\\Seen", "\\Flagged"]);
	assert.deepEqual(parseImapAppendArguments(["INBOX", "()"]).flags, []);
	assert.deepEqual(parseImapAppendArguments(["INBOX", "\\Seen"]), { error: "date-time is malformed" });
	assert.deepEqual(parseImapAppendArguments(["INBOX", "(\\Seen"]), { error: "flag list is not closed" });
	assert.deepEqual(parseImapAppendArguments(["INBOX", "((\\Seen))"]), { error: "flag list is malformed" });
	assert.deepEqual(parseImapAppendArguments([]), { error: "needs a mailbox name" });
	// A quoted date-time is one token; a client that leaves it unquoted spreads it over three and it is rejoined.
	const dated = parseImapAppendArguments(["INBOX", "(\\Seen)", "22-Nov-2026", "18:00:00", "+0000"]);
	assert.equal(dated.internalDate.toISOString(), "2026-11-22T18:00:00.000Z");
	// The quoted form goes through the command-line tokenizer first, which is how a client sends a name with
	// spaces and a date-time in one argument.
	const quoted = parseImapCommand('A APPEND "My Folder" (\\Seen) "22-Nov-2026 18:00:00 +0000"');
	const parsedQuoted = parseImapAppendArguments(quoted.args);
	assert.equal(parsedQuoted.name, "My Folder");
	assert.deepEqual(parsedQuoted.flags, ["\\Seen"]);
	assert.equal(parsedQuoted.internalDate.toISOString(), "2026-11-22T18:00:00.000Z");
});

test("RFC 3501 date-times are read with their zone offset", () => {
	assert.equal(parseImapDateTime("22-Nov-2026 18:00:00 +0000").toISOString(), "2026-11-22T18:00:00.000Z");
	assert.equal(parseImapDateTime("22-Nov-2026 18:00:00 +0200").toISOString(), "2026-11-22T16:00:00.000Z");
	assert.equal(parseImapDateTime("22-Nov-2026 18:00:00 -0500").toISOString(), "2026-11-22T23:00:00.000Z");
	assert.equal(parseImapDateTime("  1-jan-2026 00:00:00 +0000 ").toISOString(), "2026-01-01T00:00:00.000Z");
	// A date that does not exist, an unknown month, a bad clock and free text are all refused rather than rolled over.
	for (const value of ["31-Feb-2026 18:00:00 +0000", "22-Xyz-2026 18:00:00 +0000", "22-Nov-2026 24:00:00 +0000", "22-Nov-2026 18:60:00 +0000", "soon", "22 Nov 2026 18:00:00 +0000"]) {
		assert.equal(parseImapDateTime(value), null, value);
	}
});
