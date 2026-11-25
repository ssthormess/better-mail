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
	encodeModifiedUtf7,
} from "./server/runtime/imap-protocol.ts";
export { planImapMailboxEntries, resolveImapFolderTarget } from "./server/runtime/imap-mailboxes.ts";`,
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
	encodeModifiedUtf7,
	planImapMailboxEntries,
	resolveImapFolderTarget,
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
const message = (uid, overrides = {}) => ({ id: `msg${uid}`, uid, read: false, starred: false, trashed: false, draft: false, outbound: false, ...overrides });
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
const runOn = (client, line, state = session) => dispatchImapCommand(state, parseImapCommand(line), client);
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
		for (const flag of imapMessageFlags({ id: "msg1", read, starred, trashed, draft, outbound })) produced.add(flag);
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

/**
 * A backend over a mutable folder store, so it behaves like the database one where it matters
 * here: `list` is rebuilt per call, so a folder created through CREATE shows up in the next LIST.
 * `denied` stands in for the authz gate (a read-only grant) without touching the protocol.
 */
function writableBackend() {
	const store = new Map([
		["mbx1", [{ id: "fld1", name: "Receipts" }, { id: "fld2", name: "My Folder" }]],
		["mbx2", [{ id: "fld3", name: "Leads" }]],
	]);
	const state = { denied: false, writes: [], sequence: 3 };
	const client = {
		list: async () => planImapMailboxEntries([SECONDARY, PRIMARY], store),
		counts: async () => ({ messages: 0, unseen: 0 }),
		messages: async () => [],
		createFolder: async (target) => {
			state.writes.push({ verb: "create", target });
			if (state.denied) return "denied";
			const rows = store.get(target.mailboxId);
			if (rows.some((folder) => folder.name.toLowerCase() === target.name.toLowerCase())) return "exists";
			rows.push({ id: `fld${++state.sequence}`, name: target.name });
			return "ok";
		},
		deleteFolder: async (target) => {
			state.writes.push({ verb: "delete", target });
			if (state.denied) return "denied";
			const rows = store.get(target.mailboxId);
			const index = rows.findIndex((folder) => folder.id === target.folderId);
			if (index < 0) return "missing";
			rows.splice(index, 1);
			return "ok";
		},
		renameFolder: async (target, name) => {
			state.writes.push({ verb: "rename", target, name });
			if (state.denied) return "denied";
			const rows = store.get(target.mailboxId);
			const row = rows.find((folder) => folder.id === target.folderId);
			if (!row) return "missing";
			row.name = name;
			return "ok";
		},
	};
	return { client, store, state };
}

test("CREATE adds a folder to its mailbox namespace and the next LIST sees it", async () => {
	const { client } = writableBackend();
	const created = await runOn(client, "A CREATE Reports");
	assert.equal(created.response, "A OK CREATE completed\r\n");
	// RFC 3501 permits but does not require an untagged LIST here; this bridge leaves it to the client's own LIST.
	assert.equal(created.response.startsWith("* "), false);
	assert.ok(listLines((await runOn(client, 'A LIST "" "*"')).response).includes('* LIST (\\HasNoChildren) "/" Reports'));
	// The new folder is selectable straight away, because LIST and SELECT read the same fresh catalogue.
	assert.match((await runOn(client, "B SELECT Reports")).response, /B OK \[READ-ONLY\] SELECT completed/);
	// A namespaced name creates the folder in that mailbox, not in the primary one.
	assert.equal((await runOn(client, 'A CREATE "sales@example.test/Leads 2024"')).response, "A OK CREATE completed\r\n");
	const all = listLines((await runOn(client, 'A LIST "" "*"')).response);
	assert.ok(all.includes('* LIST (\\HasNoChildren) "/" "sales@example.test/Leads 2024"'));
	assert.equal(all.includes('* LIST (\\HasNoChildren) "/" "Leads 2024"'), false);
});

test("CREATE refuses reserved, existing and unusable names without touching the backend", async () => {
	const { client, state } = writableBackend();
	for (const line of ["A CREATE INBOX", "A CREATE inbox", "A CREATE Sent", "A CREATE Trash", "A CREATE Drafts", "A CREATE Archive", "A CREATE Junk"]) {
		assert.equal((await runOn(client, line)).response, "A NO CREATE is not allowed on this mailbox\r\n", line);
	}
	// An address parent is a \Noselect namespace, not a folder.
	assert.equal((await runOn(client, "A CREATE sales@example.test")).response, "A NO CREATE is not allowed on this mailbox\r\n");
	// Names are unique case-insensitively, the way the catalogue de-duplicates them.
	assert.equal((await runOn(client, "A CREATE Receipts")).response, "A NO Mailbox already exists\r\n");
	assert.equal((await runOn(client, "A CREATE receipts")).response, "A NO Mailbox already exists\r\n");
	// Folders are flat: the only delimiter use is the address prefix, so a deeper path names no mailbox.
	assert.equal((await runOn(client, "A CREATE Foo/Bar")).response, "A NO No such mailbox\r\n");
	assert.equal((await runOn(client, "A CREATE elsewhere@example.test/X")).response, "A NO No such mailbox\r\n");
	assert.equal((await runOn(client, 'A CREATE "sales@example.test/"')).response, "A NO Empty mailbox name\r\n");
	assert.equal((await runOn(client, 'A CREATE ""')).response, "A NO Empty mailbox name\r\n");
	assert.equal((await runOn(client, `A CREATE ${"x".repeat(81)}`)).response, "A NO Mailbox name is too long\r\n");
	assert.equal((await runOn(client, "A CREATE \u0026")).response, "A BAD CREATE mailbox name must be modified UTF-7\r\n");
	assert.equal((await runOn(client, "A CREATE")).response, "A BAD CREATE needs one mailbox name\r\n");
	assert.deepEqual(state.writes, []);
});

test("DELETE removes the row, and a deleted mailbox cannot stay selected", async () => {
	const { client } = writableBackend();
	const opened = await runOn(client, "A SELECT Receipts");
	assert.equal(opened.state, "selected");
	const deleted = await runOn(client, "B DELETE Receipts", opened);
	assert.equal(deleted.response, "B OK DELETE completed\r\n");
	// The selection pointed at a mailbox that no longer exists, so the session drops back instead of pretending.
	assert.equal(deleted.state, "authenticated");
	assert.equal(deleted.selected, null);
	assert.equal(listLines((await runOn(client, 'A LIST "" "*"')).response).includes('* LIST (\\HasNoChildren) "/" Receipts'), false);
	assert.equal((await runOn(client, "B DELETE Receipts")).response, "B NO No such mailbox\r\n");
	// DELETE is legal in both states (RFC 3501 §6.3.4), so an unselected session may delete too.
	assert.equal((await runOn(client, "C DELETE Leads")).response, "C NO No such mailbox\r\n");
	assert.equal((await runOn(client, 'C DELETE "sales@example.test/Leads"')).response, "C OK DELETE completed\r\n");
	for (const line of ["A DELETE INBOX", "A DELETE sales@example.test", "A DELETE Nope", "A DELETE Foo/Bar"]) {
		assert.match((await runOn(client, line)).response, /^A NO (DELETE is not allowed on this mailbox|No such mailbox)\r\n$/, line);
	}
	assert.equal((await runOn(client, "A DELETE")).response, "A BAD DELETE needs one mailbox name\r\n");
});

test("RENAME renames in place and keeps the folder id message refs point at", async () => {
	const { client } = writableBackend();
	assert.equal((await runOn(client, "A RENAME Receipts Invoices")).response, "A OK RENAME completed\r\n");
	const renamed = listLines((await runOn(client, 'A LIST "" "*"')).response);
	assert.ok(renamed.includes('* LIST (\\HasNoChildren) "/" Invoices'));
	assert.equal(renamed.includes('* LIST (\\HasNoChildren) "/" Receipts'), false);
	// The id is unchanged, so a message filed in the folder still points at the renamed folder.
	assert.equal((await runOn(client, "B SELECT Invoices")).selected.ref, "mbx1~f~fld1");
	// Renaming the selected mailbox keeps the ref and only moves the reported name.
	const opened = await runOn(client, "B SELECT Invoices");
	const moved = await runOn(client, "C RENAME Invoices Statements", opened);
	assert.equal(moved.response, "C OK RENAME completed\r\n");
	assert.equal(moved.selected.name, "Statements");
	assert.equal(moved.selected.ref, "mbx1~f~fld1");
	// A same-name (or case-only) rename is a harmless no-op rather than an "already exists" refusal.
	assert.equal((await runOn(client, "C RENAME Statements Statements")).response, "C OK RENAME completed\r\n");
	assert.equal((await runOn(client, "C RENAME Statements statements")).response, "C OK RENAME completed\r\n");
});

test("RENAME refuses a taken name, a role name and a move to another mailbox", async () => {
	const { client } = writableBackend();
	assert.equal((await runOn(client, "A RENAME Receipts \"My Folder\"")).response, "A NO Mailbox already exists\r\n");
	assert.equal((await runOn(client, "A RENAME Receipts Sent")).response, "A NO RENAME is not allowed on this mailbox\r\n");
	assert.equal((await runOn(client, "A RENAME INBOX Anything")).response, "A NO RENAME is not allowed on this mailbox\r\n");
	assert.equal((await runOn(client, "A RENAME sales@example.test Anything")).response, "A NO RENAME is not allowed on this mailbox\r\n");
	// Folders belong to one mailbox; a cross-mailbox rename would strand the mailbox's messages on a foreign folder.
	assert.equal((await runOn(client, "A RENAME Receipts \"sales@example.test/Reports\"")).response, "A NO RENAME cannot move a folder to another mailbox\r\n");
	assert.equal((await runOn(client, "A RENAME Nope Anything")).response, "A NO No such mailbox\r\n");
	assert.equal((await runOn(client, "A RENAME Receipts Foo/Bar")).response, "A NO No such mailbox\r\n");
	assert.equal((await runOn(client, "A RENAME Receipts \"\"")).response, "A NO Empty mailbox name\r\n");
	assert.equal((await runOn(client, "A RENAME Receipts")).response, "A BAD RENAME needs an old and a new mailbox name\r\n");
	assert.equal((await runOn(client, "A RENAME Receipts Missing-&")).response, "A BAD RENAME mailbox names must be modified UTF-7\r\n");
});

test("a mailbox the account may only read refuses every folder write with the unknown-name NO", async () => {
	const { client, store, state } = writableBackend();
	state.denied = true;
	for (const line of ["A CREATE Reports", "A DELETE Receipts", "A RENAME Receipts Invoices"]) {
		assert.equal((await runOn(client, line)).response, "A NO No such mailbox\r\n", line);
	}
	// Identical to the answer for a name outside every namespace, so a read-only share cannot be probed for.
	assert.equal((await runOn(client, "A CREATE elsewhere@example.test/X")).response, "A NO No such mailbox\r\n");
	assert.deepEqual(store.get("mbx1").map((folder) => folder.name), ["Receipts", "My Folder"]);
	// Nothing was attempted through the store: the three calls above are the only recorded writes.
	assert.equal(state.writes.length, 3);
});

test("a backend verdict that slipped past the catalogue check still answers honestly", async () => {
	// Another session creating the same name, or deleting the row, between the catalogue read and the write.
	const stale = {
		list: async () => entries,
		counts: async () => ({ messages: 0, unseen: 0 }),
		messages: async () => [],
		createFolder: async () => "exists",
		deleteFolder: async () => "missing",
		renameFolder: async () => "missing",
	};
	assert.equal((await runOn(stale, 'A CREATE "New Folder"')).response, "A NO Mailbox already exists\r\n");
	assert.equal((await runOn(stale, "A DELETE Receipts")).response, "A NO No such mailbox\r\n");
	assert.equal((await runOn(stale, "A RENAME Receipts Invoices")).response, "A NO No such mailbox\r\n");
	const taken = { ...stale, renameFolder: async () => "exists" };
	assert.equal((await runOn(taken, "A RENAME Receipts Invoices")).response, "A NO Mailbox already exists\r\n");
});

test("non-ASCII names cross the wire in modified UTF-7 and come back unchanged", async () => {
	const { client, store } = writableBackend();
	// RFC 3501 §5.1.3: the client sends the encoded form for "Entwürfe".
	assert.equal((await runOn(client, "A CREATE Entw&APw-rfe")).response, "A OK CREATE completed\r\n");
	assert.equal(store.get("mbx1").at(-1).name, "Entwürfe");
	assert.ok(listLines((await runOn(client, 'A LIST "" "*"')).response).includes('* LIST (\\HasNoChildren) "/" Entw&APw-rfe'));
	// The encoded name the client just saw in LIST is what SELECT resolves.
	assert.equal((await runOn(client, "B SELECT Entw&APw-rfe")).selected.name, "Entwürfe");
	assert.equal((await runOn(client, "B STATUS Entw&APw-rfe (MESSAGES)")).response, '* STATUS Entw&APw-rfe (MESSAGES 0)\r\nB OK STATUS completed\r\n');
	// A lenient client that sends raw UTF-8 is understood too, and sees the name already exists.
	assert.equal((await runOn(client, "A CREATE Entwürfe")).response, "A NO Mailbox already exists\r\n");
	// A "&" in a new name needs the "&-" escape to survive the round trip.
	assert.equal((await runOn(client, "A CREATE Rock&-Roll")).response, "A OK CREATE completed\r\n");
	assert.equal(store.get("mbx1").at(-1).name, "Rock&Roll");
	assert.ok(listLines((await runOn(client, 'A LIST "" "*"')).response).includes('* LIST (\\HasNoChildren) "/" Rock&-Roll'));
	assert.equal(formatImapName("Entwürfe"), "Entw&APw-rfe");
	assert.equal(encodeModifiedUtf7("Entwürfe"), "Entw&APw-rfe");
});

test("folder names resolve to a mailbox and a folder name, or to a refusal", () => {
	const resolve = (name) => resolveImapFolderTarget(entries, name);
	assert.equal(resolve("Receipts").kind, "folder");
	assert.deepEqual(resolve("Receipts").target, { mailboxId: "mbx1", folderId: "fld1", name: "Receipts", imapName: "Receipts" });
	assert.deepEqual(resolve("New Folder").target, { mailboxId: "mbx1", name: "New Folder", imapName: "New Folder" });
	assert.deepEqual(resolve("sales@example.test/Leads 2").target, { mailboxId: "mbx2", name: "Leads 2", imapName: "sales@example.test/Leads 2" });
	assert.equal(resolve("INBOX").kind, "role");
	assert.equal(resolve("sales@example.test").kind, "parent");
	assert.deepEqual(resolve("  Receipts  ").target.name, "Receipts");
	assert.equal(resolve("").kind, "invalid");
	assert.equal(resolve("a/b/c").kind, "invalid");
	// Without a primary mailbox no name is bare, so a root-level create has nowhere to land.
	const namespacedOnly = planImapMailboxEntries([{ ...PRIMARY, isPrimary: false }], new Map([["mbx1", [{ id: "fld9", name: "Reports" }]]]));
	assert.equal(resolveImapFolderTarget(namespacedOnly, "Reports").kind, "invalid");
	assert.equal(resolveImapFolderTarget(namespacedOnly, "alice@example.test/Reports").kind, "folder");
	assert.equal(resolveImapFolderTarget(namespacedOnly, "alice@example.test/New").kind, "new");
});

test("folder writes stay behind authentication", async () => {
	const { client, state } = writableBackend();
	for (const line of ["A CREATE Reports", "A DELETE Receipts", "A RENAME Receipts Invoices"]) {
		assert.equal((await dispatchImapCommand("not-authenticated", parseImapCommand(line), client)).response, "A BAD Authenticate first\r\n", line);
	}
	assert.deepEqual(state.writes, []);
});

/**
 * A backend that records what APPEND and MOVE asked of it, so the protocol's own decisions (name
 * resolution, flags, internal date, which UIDs to expunge) can be checked without any storage.
 */
function messageWriteBackend({ append = "ok", move = null } = {}) {
	const calls = { append: [], move: [] };
	const client = {
		list: async () => entries,
		counts: async (entry) => countsByRef.get(entry.ref) ?? { messages: 0, unseen: 0 },
		messages: async (selected) => messagesByRef.get(selected.ref) ?? [],
		append: async (request) => {
			calls.append.push(request);
			return append;
		},
		move: async (source, ids, destination) => {
			calls.move.push({ source, ids, destination });
			if (move && move.result !== "ok") return move;
			return { result: "ok", changed: move?.changed ?? ids };
		},
	};
	return { client, calls };
}

/** A command plus the literal the socket layer reads after a `{n}` marker: the bytes never go through the tokenizer. */
const literalCommand = (line, text) => {
	const parsed = parseImapCommand(line);
	const bytes = Buffer.from(text, "utf8");
	return { ...parsed, literal: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const LITERAL = "From: kevin@example.com\r\nSubject: Offer\r\n\r\nHello\r\n";

const runLiteral = (line, text, client, state = session) => dispatchImapCommand(state, literalCommand(line, text), client);

test("APPEND resolves its destination, flags and internal date, then hands the bytes over", async () => {
	const { client, calls } = messageWriteBackend();
	assert.equal((await runLiteral("A APPEND INBOX (\\Seen \\Flagged)", LITERAL, client)).response, "A OK APPEND completed\r\n");
	assert.equal(calls.append.length, 1);
	assert.equal(calls.append[0].entry.ref, "mbx1~inbox");
	assert.deepEqual(calls.append[0].flags, ["\\Seen", "\\Flagged"]);
	assert.equal(calls.append[0].internalDate, null);
	// The literal arrives as the message bytes, not as a token that was round-tripped through text.
	assert.equal(new TextDecoder().decode(calls.append[0].raw), LITERAL);
	assert.equal(calls.append[0].raw.byteLength, Buffer.byteLength(LITERAL));

	// A namespaced custom folder and a role mailbox resolve through the same catalogue SELECT uses.
	await runLiteral('B APPEND "sales@example.test/Leads"', LITERAL, client);
	assert.equal(calls.append[1].entry.ref, "mbx2~f~fld3");
	assert.equal(calls.append[1].entry.mailboxId, "mbx2");
	await runLiteral("C APPEND Drafts (\\Draft)", LITERAL, client);
	assert.equal(calls.append[2].entry.ref, "mbx1~drafts");
	assert.deepEqual(calls.append[2].flags, ["\\Draft"]);
	// An empty flag list and a date-time are both legal.
	await runLiteral('D APPEND INBOX () "22-Nov-2026 18:00:00 +0000"', LITERAL, client);
	assert.deepEqual(calls.append[3].flags, []);
	assert.equal(calls.append[3].internalDate.toISOString(), "2026-11-22T18:00:00.000Z");
	// Keywords and \Recent have no column: they are dropped rather than reported as flags nothing holds.
	await runLiteral("E APPEND INBOX (\\Recent $label1)", LITERAL, client);
	assert.deepEqual(calls.append[4].flags, []);
});

test("APPEND refuses what it cannot store, before the backend is asked", async () => {
	const { client, calls } = messageWriteBackend();
	// RFC 3501 §6.3.11 names TRYCREATE for a mailbox that does not exist.
	assert.equal((await runLiteral("A APPEND Nope", LITERAL, client)).response, "A NO [TRYCREATE] No such mailbox\r\n");
	// \Draft and \Deleted are the Drafts and Trash mailboxes, so a flag that contradicts the destination is refused.
	assert.equal((await runLiteral("B APPEND INBOX (\\Draft)", LITERAL, client)).response, "B NO Drafts mail is only appendable to the Drafts mailbox\r\n");
	assert.equal((await runLiteral("C APPEND Sent (\\Deleted)", LITERAL, client)).response, "C NO Deleted mail is only appendable to the Trash mailbox\r\n");
	assert.equal((await runLiteral("D APPEND Receipts (\\Draft)", LITERAL, client)).response, "D NO Drafts mail is only appendable to the Drafts mailbox\r\n");
	// A malformed command line is a protocol error, so the client knows to fix it rather than retry the message.
	assert.equal((await runOn(client, "E APPEND INBOX")).response, "E BAD APPEND needs a message literal\r\n");
	assert.equal((await dispatchImapCommand(session, literalCommand("E2 APPEND INBOX", ""), client)).response, "E2 BAD APPEND needs a message literal\r\n");
	assert.equal((await runLiteral("F APPEND INBOX (\\Seen", LITERAL, client)).response, "F BAD APPEND flag list is not closed\r\n");
	assert.equal((await runLiteral("G APPEND INBOX (\\Seen) tomorrow", LITERAL, client)).response, "G BAD APPEND date-time is malformed\r\n");
	assert.equal((await runLiteral("H APPEND \u0026", LITERAL, client)).response, "H BAD APPEND mailbox name must be modified UTF-7\r\n");
	// The protocol cap is the same one JMAP uploads use, so APPEND cannot store what no other path would accept.
	const oversize = { ...literalCommand("I APPEND INBOX", LITERAL), literal: new ArrayBuffer(11 * 1024 * 1024) };
	// The same limit one layer down: the socket refuses it before it buffers, and so does the protocol.
	assert.match((await dispatchImapCommand(session, oversize, client)).response, /^I NO Literal too large\r\n$/);
	assert.deepEqual(calls.append, []);
});

test("APPEND reports what the storage seam did with the message", async () => {
	const denied = messageWriteBackend({ append: "denied" }).client;
	assert.equal((await runLiteral("A APPEND INBOX", LITERAL, denied)).response, "A NO APPEND is not allowed on this mailbox\r\n");
	// A duplicate Message-ID is stored already, which is what OK means: there is nothing for the client to fix.
	const duplicate = messageWriteBackend({ append: "duplicate" }).client;
	assert.equal((await runLiteral("B APPEND INBOX", LITERAL, duplicate)).response, "B OK APPEND completed\r\n");
	const rejected = messageWriteBackend({ append: "invalid" }).client;
	assert.equal((await runLiteral("C APPEND INBOX", LITERAL, rejected)).response, "C NO Message could not be stored\r\n");
});

test("MOVE re-files the sequence set and expunges what left the mailbox, newest first", async () => {
	const { client, calls } = messageWriteBackend();
	const inbox = await runOn(client, "A SELECT INBOX");
	assert.equal(inbox.selected.ref, "mbx1~inbox");
	// EXPUNGE responses are in descending order so the remaining sequence numbers stay valid (RFC 3501 §7.4.1).
	assert.equal((await runOn(client, "B MOVE 1:2 Receipts", inbox)).response, "* 2 EXPUNGE\r\n* 1 EXPUNGE\r\nB OK MOVE completed\r\n");
	assert.deepEqual(calls.move[0].ids, ["msg1", "msg2"]);
	assert.equal(calls.move[0].source.ref, "mbx1~inbox");
	assert.equal(calls.move[0].destination.ref, "mbx1~f~fld1");
	// A UID is a position here, so UID MOVE takes the same numbers.
	assert.equal((await runOn(client, "C UID MOVE 3 Trash", inbox)).response, "* 3 EXPUNGE\r\nC OK UID MOVE completed\r\n");
	assert.deepEqual(calls.move[1].ids, ["msg3"]);
	// Only the messages the backend says it changed are expunged: a move level with a message already there
	// changes nothing, so the client is not told to drop a row that is still listed.
	const partial = messageWriteBackend({ move: { result: "ok", changed: ["msg1"] } });
	assert.equal((await runOn(partial.client, "D MOVE 1:3 Receipts", inbox)).response, "* 1 EXPUNGE\r\nD OK MOVE completed\r\n");
	const noop = messageWriteBackend({ move: { result: "ok", changed: [] } });
	assert.equal((await runOn(noop.client, "E MOVE 1 Receipts", inbox)).response, "E OK MOVE completed\r\n");
	// The selection survives a move, unlike a DELETE of the selected mailbox.
	assert.equal((await runOn(client, "F NOOP", inbox)).response, "F OK NOOP completed\r\n");
});

test("MOVE answers NO for what the mailbox model cannot represent", async () => {
	const { client, calls } = messageWriteBackend();
	const inbox = await runOn(client, "A SELECT INBOX");
	assert.equal((await runOn(client, "B MOVE 1 Receipts")).response, "B BAD No mailbox selected\r\n");
	assert.equal((await runOn(client, "C MOVE 1", inbox)).response, "C BAD MOVE needs a sequence set and a mailbox name\r\n");
	assert.equal((await runOn(client, "D MOVE 9 Receipts", inbox)).response, "D BAD MOVE sequence set is malformed or out of range\r\n");
	assert.equal((await runOn(client, "E MOVE 1 Nope", inbox)).response, "E NO [TRYCREATE] No such mailbox\r\n");
	assert.equal((await runOn(client, "F MOVE 1 \u0026", inbox)).response, "F BAD MOVE mailbox name must be modified UTF-7\r\n");
	assert.deepEqual(calls.move, []);
	const denied = messageWriteBackend({ move: { result: "denied" } });
	assert.equal((await runOn(denied.client, "G MOVE 1 Receipts", inbox)).response, "G NO MOVE is not allowed on this mailbox\r\n");
	const cross = messageWriteBackend({ move: { result: "cross-mailbox" } });
	assert.equal((await runOn(cross.client, "H MOVE 1 \"sales@example.test/INBOX\"", inbox)).response, "H NO MOVE cannot move mail between mailboxes\r\n");
	const invalid = messageWriteBackend({ move: { result: "invalid", description: "Received mail cannot be moved to Sent" } });
	assert.equal((await runOn(invalid.client, "I MOVE 1 Sent", inbox)).response, "I NO Received mail cannot be moved to Sent\r\n");
	const missing = messageWriteBackend({ move: { result: "missing" } });
	assert.equal((await runOn(missing.client, "J MOVE 1 Receipts", inbox)).response, "J NO No such mailbox\r\n");
});

test("the write slice is APPEND and MOVE only", async () => {
	const { client } = messageWriteBackend();
	const inbox = await runOn(client, "A SELECT INBOX");
	// Capability is how a client knows MOVE is there (RFC 6851 §3.1) and how big an APPEND it may send (RFC 7889).
	assert.match((await run("A CAPABILITY")).response, /^\* CAPABILITY IMAP4rev1 MOVE ID APPENDLIMIT=10485760\r\n/);
	for (const line of ["B STORE 1 +FLAGS (\\Seen)", "C UID STORE 1 +FLAGS (\\Seen)", "D COPY 1 Receipts", "E UID COPY 1 Receipts", "F EXPUNGE", "G UID EXPUNGE 1"]) {
		assert.equal((await runOn(client, line, inbox)).response, `${line.split(" ")[0]} NO Not implemented yet\r\n`, line);
	}
	// APPEND writes messages; it does not make flags mutable in a session.
	const selected = await runOn(client, "H SELECT INBOX");
	assert.match(selected.response, /\* OK \[PERMANENTFLAGS \(\)\] Read-only mailbox/);
	assert.match(selected.response, /\* OK \[UIDNEXT 4\] Predicted next UID/);
});
