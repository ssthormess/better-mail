import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-imap-mailboxes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `export {
	parseImapCommand,
	dispatchImapCommand,
	parseImapStatusItems,
	parseImapFetchItems,
	parseImapSequenceSet,
	imapMessageFlags,
	IMAP_FLAGS,
	matchImapPattern,
	selectImapListEntries,
	resolveImapMailbox,
	imapUidValidity,
	formatImapName,
	formatImapListEntry,
} from "./server/runtime/imap-protocol.ts";
export { planImapMailboxEntries } from "./server/runtime/imap-mailboxes.ts";`,
		resolveDir: root,
		sourcefile: "imap-mailboxes-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const {
	parseImapCommand,
	dispatchImapCommand,
	parseImapStatusItems,
	parseImapFetchItems,
	parseImapSequenceSet,
	imapMessageFlags,
	IMAP_FLAGS,
	matchImapPattern,
	selectImapListEntries,
	resolveImapMailbox,
	imapUidValidity,
	formatImapName,
	formatImapListEntry,
	planImapMailboxEntries,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const PRIMARY = { id: "mbx1", localPart: "alice", hostname: "example.test", isPrimary: true };
const SECONDARY = { id: "mbx2", localPart: "sales", hostname: "example.test", isPrimary: false };

const entries = planImapMailboxEntries(
	[SECONDARY, PRIMARY],
	new Map([
		["mbx1", [{ id: "fld1", name: "Receipts" }, { id: "fld2", name: "My Folder" }]],
		["mbx2", [{ id: "fld3", name: "Leads" }]],
	]),
);

const countsByRef = new Map([
	["mbx1~inbox", { messages: 3, unseen: 1 }],
	["mbx1~sent", { messages: 7, unseen: 0 }],
	["mbx2~inbox", { messages: 2, unseen: 2 }],
]);
/**
 * Rows as the backend hands them over: one per flag column, so the mapping is pinned to
 * `read`/`starred`/`trashed_at`/`status='draft'`/`direction` rather than to a flag string.
 */
const message = (uid, overrides = {}) => ({ uid, read: false, starred: false, trashed: false, draft: false, outbound: false, ...overrides });
const messagesByRef = new Map([
	["mbx1~inbox", [message(1), message(2, { read: true, starred: true }), message(3, { trashed: true })]],
	["mbx1~drafts", [message(1, { draft: true, outbound: true })]],
	["mbx1~sent", [message(1, { outbound: true }), message(2, { outbound: true, starred: true })]],
]);
const backend = {
	list: async () => entries,
	counts: async (entry) => countsByRef.get(entry.ref) ?? { messages: 0, unseen: 0 },
	messages: async (selected) => messagesByRef.get(selected.ref) ?? [],
};
const session = { state: "authenticated", selected: null };
const run = (line, state = session) => dispatchImapCommand(state, parseImapCommand(line), backend);
const verbLines = (verb, response) => response.split("\r\n").filter((line) => line.startsWith(`* ${verb}`));
const listLines = (response) => verbLines("LIST", response);

test("the catalogue names the primary mailbox bare and namespaces every other mailbox", () => {
	const names = entries.map((entry) => entry.name);
	assert.deepEqual(names.slice(0, 9), [
		"INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash", "My Folder", "Receipts",
		"sales@example.test",
	]);
	assert.deepEqual(names.slice(9), [
		"sales@example.test/INBOX",
		"sales@example.test/Sent",
		"sales@example.test/Drafts",
		"sales@example.test/Archive",
		"sales@example.test/Junk",
		"sales@example.test/Trash",
		"sales@example.test/Leads",
	]);
	const parent = entries.find((entry) => entry.name === "sales@example.test");
	assert.equal(parent.selectable, false);
	assert.equal(parent.ref, "");
	assert.equal(entries.find((entry) => entry.name === "sales@example.test/INBOX").ref, "mbx2~inbox");
	assert.equal(entries.find((entry) => entry.name === "Receipts").ref, "mbx1~f~fld1");
	assert.equal(entries.find((entry) => entry.name === "INBOX").role, "inbox");
});

test("a lone primary mailbox needs no namespace parent and shadowing folders are skipped", () => {
	const alone = planImapMailboxEntries([PRIMARY], new Map([["mbx1", [{ id: "fld1", name: "sent" }, { id: "fld2", name: "Archive" }]]]));
	assert.deepEqual(alone.map((entry) => entry.name), ["INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash"]);
	const noPrimary = planImapMailboxEntries([{ ...SECONDARY, isPrimary: false }, { ...PRIMARY, isPrimary: false }]);
	assert.ok(noPrimary.some((entry) => entry.name === "sales@example.test"));
	assert.equal(noPrimary.some((entry) => entry.name === "INBOX"), false);
	// Without a primary address every mailbox is namespaced, so both get a \Noselect parent.
	assert.deepEqual(noPrimary.filter((entry) => !entry.selectable).map((entry) => entry.name), ["alice@example.test", "sales@example.test"]);
});

test("LIST replies with attributes, the delimiter and the matching names", async () => {
	const all = listLines((await run('A LIST "" "*"')).response);
	assert.equal(all.length, entries.length);
	assert.ok(all.includes('* LIST (\\HasNoChildren) "/" INBOX'));
	assert.ok(all.includes('* LIST (\\HasNoChildren) "/" "My Folder"'));
	assert.ok(all.includes('* LIST (\\HasChildren \\Noselect) "/" sales@example.test'));
	assert.ok(all.includes('* LIST (\\HasNoChildren) "/" sales@example.test/INBOX'));

	const top = listLines((await run('A LIST "" "%"')).response);
	assert.ok(top.includes('* LIST (\\HasNoChildren) "/" INBOX'));
	assert.ok(top.includes('* LIST (\\HasChildren \\Noselect) "/" sales@example.test'));
	assert.equal(top.some((line) => line.includes("sales@example.test/INBOX")), false);

	const scoped = listLines((await run('A LIST "sales@example.test/" "*"')).response);
	assert.equal(scoped.length, 7);
	assert.equal(scoped.some((line) => line.endsWith('"sales@example.test"')), false);

	// LSUB has no subscription tracking yet, so it answers exactly what LIST answers.
	assert.deepEqual(verbLines("LSUB", (await run('A LSUB "" "*"')).response), all.map((line) => line.replace("* LIST", "* LSUB")));
	assert.match((await run('A LIST "" ""')).response, /^\* LIST \(\\Noselect\) "\/" ""\r\nA OK LIST completed\r\n$/);
	assert.match((await run("A LIST INBOX")).response, /A BAD LIST needs a reference and a mailbox pattern/);
});

test("SELECT resolves role, folder and namespaced names and answers the read-only block", async () => {
	const response = (await run("A SELECT INBOX")).response;
	assert.match(response, /^\* 3 EXISTS\r\n\* 0 RECENT\r\n\* FLAGS \(\\Seen \\Flagged \\Draft \\Deleted\)\r\n/);
	assert.match(response, /\* OK \[UIDVALIDITY \d+\] /);
	assert.match(response, /\* OK \[UIDNEXT 4\] /);
	assert.match(response, /\* OK \[PERMANENTFLAGS \(\)\] /);
	assert.match(response, /A OK \[READ-ONLY\] SELECT completed\r\n$/);
	const opened = await run("A SELECT INBOX");
	assert.equal(opened.state, "selected");
	assert.equal(opened.selected.name, "INBOX");
	assert.equal(opened.selected.ref, "mbx1~inbox");
	assert.equal(opened.selected.uidValidity, imapUidValidity("mbx1~inbox"));

	// INBOX is case-insensitive, namespaced names are exact, and a folder id works through its own name.
	assert.equal((await run("A SELECT inbox")).selected.ref, "mbx1~inbox");
	assert.equal((await run('A SELECT "sales@example.test/Sent"')).selected.name, "sales@example.test/Sent");
	assert.equal((await run('A SELECT "sales@example.test/Leads"')).selected.ref, "mbx2~f~fld3");
	assert.equal((await run('A SELECT "mbx1~f~fld1"')).selected.name, "Receipts");
	assert.match((await run("A EXAMINE INBOX")).response, /A OK \[READ-ONLY\] EXAMINE completed\r\n$/);
});

test("SELECT refuses names it cannot address without leaking why", async () => {
	assert.equal((await run("A SELECT Nope")).response, "A NO No such mailbox\r\n");
	assert.equal((await run('A SELECT "sales@example.test"')).response, "A NO No such mailbox\r\n");
	assert.equal((await run("A SELECT")).response, "A BAD SELECT needs one mailbox name\r\n");
});

test("a failed SELECT or EXAMINE drops the previous selection", async () => {
	const opened = await run("A SELECT INBOX");
	assert.equal(opened.state, "selected");
	for (const line of ["B SELECT Nope", "B EXAMINE Nope", 'B SELECT "sales@example.test"']) {
		const failed = await run(line, opened);
		assert.match(failed.response, /^B NO No such mailbox\r\n$/);
		assert.equal(failed.state, "authenticated");
		assert.equal(failed.selected, null);
	}
	// RFC 3501 §6.3.2 covers a mailbox that fails to open; a syntax BAD leaves the session alone.
	const syntax = await run("B SELECT", opened);
	assert.match(syntax.response, /^B BAD /);
	assert.equal(syntax.state, undefined);
	assert.equal(syntax.selected, undefined);
});

test("SELECT and FETCH advertise only the flags the bridge can report", async () => {
	assert.deepEqual([...IMAP_FLAGS], ["\\Seen", "\\Flagged", "\\Draft", "\\Deleted"]);
	// No \\Answered (nothing stores replied state) and no \\Recent (there is no RECENT tracking).
	assert.equal(IMAP_FLAGS.includes("\\Answered"), false);
	const advertisement = (await run("A SELECT INBOX")).response.split("\r\n").find((line) => line.startsWith("* FLAGS"));
	const advertised = advertisement.slice(advertisement.indexOf("(") + 1, -1).split(" ");
	const produced = new Set();
	for (const read of [false, true]) for (const starred of [false, true]) for (const trashed of [false, true]) for (const draft of [false, true]) for (const outbound of [false, true]) {
		for (const flag of imapMessageFlags({ read, starred, trashed, draft, outbound })) produced.add(flag);
	}
	assert.deepEqual([...produced].sort(), [...advertised].sort());
});

test("FETCH reports the flags each column holds", async () => {
	const inbox = await run("A SELECT INBOX");
	assert.equal((await run("B FETCH 1 FLAGS", inbox)).response, "* 1 FETCH (FLAGS ())\r\nB OK FETCH completed\r\n");
	// read + starred are the Seen and Flagged columns.
	assert.equal((await run("B FETCH 2 (FLAGS UID)", inbox)).response, "* 2 FETCH (FLAGS (\\Seen \\Flagged) UID 2)\r\nB OK FETCH completed\r\n");
	// trashed_at is Deleted; trashed mail stays listable because there is no EXPUNGE.
	assert.equal((await run("B FETCH 3 FLAGS", inbox)).response, "* 3 FETCH (FLAGS (\\Deleted))\r\nB OK FETCH completed\r\n");
	// status = 'draft' is the draft marker, and outbound mail is always seen.
	const drafts = await run("B SELECT Drafts", inbox);
	assert.equal(drafts.selected.ref, "mbx1~drafts");
	assert.equal((await run("B FETCH 1 (UID FLAGS)", drafts)).response, "* 1 FETCH (UID 1 FLAGS (\\Seen \\Draft))\r\nB OK FETCH completed\r\n");
	const sent = await run("B SELECT Sent", inbox);
	assert.equal((await run("B FETCH 2 FLAGS", sent)).response, "* 2 FETCH (FLAGS (\\Seen \\Flagged))\r\nB OK FETCH completed\r\n");
});

test("FETCH walks the sequence set and UID FETCH always answers a UID", async () => {
	const inbox = await run("A SELECT INBOX");
	const all = (await run("B FETCH 1:* (UID FLAGS)", inbox)).response.split("\r\n");
	assert.deepEqual(all.slice(0, 3), [
		"* 1 FETCH (UID 1 FLAGS ())",
		"* 2 FETCH (UID 2 FLAGS (\\Seen \\Flagged))",
		"* 3 FETCH (UID 3 FLAGS (\\Deleted))",
	]);
	assert.equal(all[3], "B OK FETCH completed");
	// `*` is the last message and a reversed range still means both ends.
	assert.equal((await run("B FETCH * UID", inbox)).response, "* 3 FETCH (UID 3)\r\nB OK FETCH completed\r\n");
	assert.equal((await run("B FETCH 3:1 UID", inbox)).response.split("\r\n").slice(0, 3).join("|"), "* 1 FETCH (UID 1)|* 2 FETCH (UID 2)|* 3 FETCH (UID 3)");
	assert.equal((await run("B FETCH 1,3 FLAGS", inbox)).response.split("\r\n").slice(0, 2).join("|"), "* 1 FETCH (FLAGS ())|* 3 FETCH (FLAGS (\\Deleted))");
	// RFC 3501 §6.4.8: UID FETCH reports the UID even when the client asked for FLAGS only.
	assert.equal((await run("B UID FETCH 2 FLAGS", inbox)).response, "* 2 FETCH (FLAGS (\\Seen \\Flagged) UID 2)\r\nB OK UID FETCH completed\r\n");
	assert.equal((await run("B UID FETCH 2 (FLAGS UID)", inbox)).response, "* 2 FETCH (FLAGS (\\Seen \\Flagged) UID 2)\r\nB OK UID FETCH completed\r\n");
	// Sequence number and UID are the same positional number, so `UID FETCH 2:*` matches like `2:*`.
	assert.equal((await run("B UID FETCH 2:* UID", inbox)).response.split("\r\n").slice(0, 2).join("|"), "* 2 FETCH (UID 2)|* 3 FETCH (UID 3)");
});

test("FETCH refuses what it cannot answer instead of inventing data", async () => {
	const inbox = await run("A SELECT INBOX");
	for (const line of ["B FETCH 4 FLAGS", "B FETCH 0 FLAGS", "B FETCH 1:4 FLAGS", "B FETCH 1:0 FLAGS", "B FETCH 1:2:3 FLAGS", "B FETCH abc FLAGS", "B FETCH ,, FLAGS"]) {
		assert.match((await run(line, inbox)).response, /^B BAD FETCH sequence set is malformed or out of range\r\n$/);
	}
	// Only FLAGS and UID exist here: no ENVELOPE/BODY/all-macro answers, no writes.
	for (const line of ["B FETCH 1 ALL", "B FETCH 1 ENVELOPE", "B FETCH 1 (FLAGS BODY[])", "B FETCH 1 (FLAGS UID"]) {
		assert.match((await run(line, inbox)).response, /^B BAD FETCH /);
	}
	assert.match((await run("B FETCH", inbox)).response, /^B BAD FETCH needs a sequence set and data items\r\n$/);
	assert.match((await run("B FETCH 1", inbox)).response, /^B BAD FETCH needs a sequence set and data items\r\n$/);
	assert.match((await run("B UID STORE 1 +FLAGS (\\Seen)", inbox)).response, /^B NO Not implemented yet\r\n$/);
	assert.match((await run("B UID EXPUNGE", inbox)).response, /^B NO Not implemented yet\r\n$/);
	assert.match((await run("B UID", inbox)).response, /^B BAD UID needs a subcommand\r\n$/);
	// An empty mailbox has no last message, so even `*` cannot name one.
	const empty = await run('B SELECT "My Folder"', inbox);
	assert.equal((await run("B FETCH 1:* FLAGS", empty)).response, "B BAD Mailbox is empty\r\n");
});

test("FETCH needs a selected mailbox, not just an authenticated session", async () => {
	for (const line of ["B FETCH 1 FLAGS", "B UID FETCH 1 FLAGS"]) {
		assert.equal((await run(line, session)).response, "B BAD No mailbox selected\r\n");
	}
	const opened = await run("A SELECT INBOX");
	const closed = await run("B UNSELECT", opened);
	assert.equal(closed.state, "authenticated");
	assert.equal((await run("B FETCH 1 FLAGS", closed)).response, "B BAD No mailbox selected\r\n");
});

test("sequence sets and fetch item lists parse the way the replies above rely on", async () => {
	assert.deepEqual(parseImapSequenceSet("1", 3), [1]);
	assert.deepEqual(parseImapSequenceSet("*", 3), [3]);
	assert.deepEqual(parseImapSequenceSet("1:2", 3), [1, 2]);
	assert.deepEqual(parseImapSequenceSet("2:*", 3), [2, 3]);
	assert.deepEqual(parseImapSequenceSet("*:2", 3), [2, 3]);
	assert.deepEqual(parseImapSequenceSet("3:1", 3), [1, 2, 3]);
	assert.deepEqual(parseImapSequenceSet("1,3", 3), [1, 3]);
	assert.deepEqual(parseImapSequenceSet("2,2:3,1", 3), [1, 2, 3]);
	for (const value of ["", ",", "1,", ",1", "0", "4", "1:4", "2:1:3", "1:*:2", "*1", "-", "1:0"]) assert.equal(parseImapSequenceSet(value, 3), null, value);
	assert.equal(parseImapSequenceSet("1", 0), null);
	assert.deepEqual(parseImapFetchItems(["(FLAGS", "UID)"]), ["FLAGS", "UID"]);
	assert.deepEqual(parseImapFetchItems(["(FLAGS)"]), ["FLAGS"]);
	assert.deepEqual(parseImapFetchItems(["FLAGS"]), ["FLAGS"]);
	assert.deepEqual(parseImapFetchItems(["flags", "uid"]), ["FLAGS", "UID"]);
	assert.equal(parseImapFetchItems([]), null);
	assert.equal(parseImapFetchItems(["()"]), null);
	assert.equal(parseImapFetchItems(["(FLAGS", "UID"]), null);
	assert.equal(parseImapFetchItems(["((FLAGS))"]), null);
});

test("the parser hands the mailbox verbs the arguments they expect", () => {
	assert.deepEqual(parseImapCommand('A LIST "" "*"'), { tag: "A", verb: "LIST", args: ["", "*"] });
	assert.deepEqual(parseImapCommand('A LIST "" %'), { tag: "A", verb: "LIST", args: ["", "%"] });
	assert.deepEqual(parseImapCommand('A LIST "sales@example.test/" "*"'), { tag: "A", verb: "LIST", args: ["sales@example.test/", "*"] });
	assert.deepEqual(parseImapCommand('A SELECT "sales@example.test/Sent"'), { tag: "A", verb: "SELECT", args: ["sales@example.test/Sent"] });
	assert.deepEqual(parseImapCommand("A STATUS INBOX (MESSAGES UNSEEN)").args, ["INBOX", "(MESSAGES", "UNSEEN)"]);
	assert.deepEqual(parseImapStatusItems(["(MESSAGES", "UNSEEN)"]), ["MESSAGES", "UNSEEN"]);
	assert.equal(parseImapStatusItems(["MESSAGES"]), null);
	assert.equal(parseImapStatusItems(["()"]), null);
});

test("STATUS reports the requested counters and ignores unknown items", async () => {
	assert.equal((await run("A STATUS INBOX (MESSAGES UNSEEN)")).response, '* STATUS INBOX (MESSAGES 3 UNSEEN 1)\r\nA OK STATUS completed\r\n');
	assert.equal((await run('A STATUS "sales@example.test/INBOX" (MESSAGES)')).response, '* STATUS sales@example.test/INBOX (MESSAGES 2)\r\nA OK STATUS completed\r\n');
	const block = (await run('A STATUS "My Folder" (MESSAGES RECENT UIDNEXT UIDVALIDITY SIZE)')).response;
	assert.match(block, /^\* STATUS "My Folder" \(MESSAGES 0 RECENT 0 UIDNEXT 1 UIDVALIDITY \d+\)\r\n/);
	assert.match(block, /A OK STATUS completed\r\n$/);
	assert.equal((await run("A STATUS INBOX")).response, "A BAD STATUS needs a mailbox name and a data item list\r\n");
	assert.match((await run("A STATUS INBOX MESSAGES")).response, /^A BAD STATUS data items/);
	assert.equal((await run("A STATUS Nope (MESSAGES)")).response, "A NO No such mailbox\r\n");
});

test("CLOSE and UNSELECT drop back to authenticated, and only when a mailbox is open", async () => {
	const opened = await run("A SELECT INBOX");
	for (const verb of ["UNSELECT", "CLOSE"]) {
		const closed = await run(`A ${verb}`, opened);
		assert.equal(closed.response, `A OK ${verb} completed\r\n`);
		assert.equal(closed.state, "authenticated");
		assert.equal(closed.selected, null);
		assert.equal((await run(`A ${verb}`, session)).response, "A NO No mailbox selected\r\n");
	}
	const loggedOut = await dispatchImapCommand(opened, parseImapCommand("A LOGOUT"), backend);
	assert.equal(loggedOut.state, "logged-out");
	assert.equal(loggedOut.selected, null);
});

test("mailbox verbs stay behind authentication and the selected phase is honest", async () => {
	for (const line of ["A LIST \"\" \"*\"", "A SELECT INBOX", "A STATUS INBOX (MESSAGES)", "A UNSELECT"]) {
		assert.equal((await dispatchImapCommand("not-authenticated", parseImapCommand(line), backend)).response, "A BAD Authenticate first\r\n");
	}
	assert.match((await dispatchImapCommand("logged-out", parseImapCommand("A LIST \"\" \"*\""), backend)).response, /A BAD Connection is closing/);
});

test("patterns, names and UIDVALIDITY behave the way the replies above rely on", () => {
	assert.equal(matchImapPattern("*", "sales@example.test/INBOX"), true);
	assert.equal(matchImapPattern("%", "sales@example.test/INBOX"), false);
	assert.equal(matchImapPattern("%", "INBOX"), true);
	assert.equal(matchImapPattern("in*", "INBOX"), true);
	assert.equal(matchImapPattern("Sent", "Drafts"), false);
	assert.deepEqual(selectImapListEntries(entries, "", "INBOX").map((entry) => entry.name), ["INBOX"]);
	// A reference this server cannot interpret lists everything rather than hiding it.
	assert.equal(selectImapListEntries(entries, "uninterpretable", "*").length, entries.length);
	assert.equal(formatImapName("INBOX"), "INBOX");
	assert.equal(formatImapName("My Folder"), '"My Folder"');
	assert.equal(formatImapName('quote"here'), '"quote\\"here"');
	assert.equal(formatImapListEntry("LIST", { name: "My Folder", selectable: true }), '* LIST (\\HasNoChildren) "/" "My Folder"');
	const uidValidity = imapUidValidity("mbx1~inbox");
	assert.equal(uidValidity, imapUidValidity("mbx1~inbox"));
	assert.notEqual(uidValidity, imapUidValidity("mbx1~sent"));
	assert.ok(uidValidity >= 1 && uidValidity <= 2147483647);
	assert.equal(resolveImapMailbox(entries, "inbox").ref, "mbx1~inbox");
	assert.equal(resolveImapMailbox(entries, "sales@example.test/INBOX").mailboxId, "mbx2");
	assert.equal(resolveImapMailbox(entries, "sales@example.test"), null);
	assert.equal(resolveImapMailbox(entries, ""), null);
});
