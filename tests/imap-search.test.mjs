import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Under node_modules so the externally-kept `drizzle-orm` specifier resolves exactly as the app resolves it.
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-imap-search-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { sql } from "drizzle-orm";
			export { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
			export {
				parseImapSearchQuery,
				parseImapSearchDate,
				isImapSetSyntax,
				resolveImapSet,
				IMAP_SEARCH_CHARSETS,
			} from "./server/runtime/imap-search.ts";
			export { buildImapSearchConditions } from "./server/runtime/imap-search-sql.ts";
			export { parseImapCommand, dispatchImapCommand } from "./server/runtime/imap-protocol.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-search-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const {
	sql,
	SQLiteSyncDialect,
	parseImapSearchQuery,
	parseImapSearchDate,
	isImapSetSyntax,
	resolveImapSet,
	IMAP_SEARCH_CHARSETS,
	buildImapSearchConditions,
	parseImapCommand,
	dispatchImapCommand,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const dialect = new SQLiteSyncDialect();
const day = (value) => Date.UTC(...value.split("-").map((part, index) => (index === 1 ? Number(part) - 1 : Number(part)))) / 1000;

/**
 * A `messages` table with the columns SEARCH reads, and rows chosen so every criterion has a message it must
 * match and one it must not. `trashed_at` and `created_at` are the integer seconds the schema stores, and the
 * booleans are the 0/1 an integer column holds.
 */
const ROWS = [
	{
		id: "m1", subject: "Welcome to Mailflare", from_addr: "alice@example.test", to_addr: "bob@example.test",
		cc_addr: null, bcc_addr: null, text_body: "hello world", html_body: "<p>markup-only-token</p>",
		read: 0, starred: 0, trashed_at: null, status: "received", direction: "inbound", created_at: day("2026-01-05"),
	},
	{
		id: "m2", subject: "Invoice 42 from shop", from_addr: "billing@shop.test", to_addr: "bob@example.test, carol@example.test",
		cc_addr: "dave@example.test", bcc_addr: "secret@example.test", text_body: null, html_body: "<p>unsubscribe here</p>",
		read: 1, starred: 1, trashed_at: day("2026-02-01"), status: "received", direction: "inbound", created_at: day("2026-02-14"),
	},
	{
		id: "m3", subject: null, from_addr: "news@list.test", to_addr: "bob@example.test",
		cc_addr: null, bcc_addr: null, text_body: "digest", html_body: null,
		read: 0, starred: 0, trashed_at: null, status: "received", direction: "inbound", created_at: day("2026-03-01"),
	},
	{
		id: "m4", subject: "Re: Invoice 42", from_addr: "bob@example.test", to_addr: "billing@shop.test",
		cc_addr: null, bcc_addr: null, text_body: "thanks", html_body: null,
		// Outbound mail is \Seen whatever `read` says: the UNSEEN counter does not count it either.
		read: 0, starred: 0, trashed_at: null, status: "sent", direction: "outbound", created_at: day("2026-03-02"),
	},
	{
		id: "m5", subject: "Draft idea", from_addr: "bob@example.test", to_addr: "carol@example.test",
		cc_addr: null, bcc_addr: null, text_body: "rough", html_body: null,
		read: 0, starred: 0, trashed_at: null, status: "draft", direction: "outbound", created_at: day("2026-03-03"),
	},
	{
		id: "m6", subject: "Report 100% done_2026", from_addr: "reports@example.test", to_addr: "bob@example.test",
		cc_addr: null, bcc_addr: null, text_body: "numbers", html_body: null,
		read: 0, starred: 0, trashed_at: null, status: "received", direction: "inbound", created_at: day("2026-03-04"),
	},
];

function openDatabase() {
	const db = new DatabaseSync(":memory:");
	db.exec(`create table messages (
		id text primary key,
		subject text,
		from_addr text not null,
		to_addr text not null,
		cc_addr text,
		bcc_addr text,
		text_body text,
		html_body text,
		read integer not null,
		starred integer not null,
		trashed_at integer,
		status text not null,
		direction text not null,
		created_at integer not null
	)`);
	const insert = db.prepare(
		"insert into messages (id, subject, from_addr, to_addr, cc_addr, bcc_addr, text_body, html_body, read, starred, trashed_at, status, direction, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	for (const row of ROWS) {
		insert.run(
			row.id, row.subject, row.from_addr, row.to_addr, row.cc_addr, row.bcc_addr, row.text_body, row.html_body,
			row.read, row.starred, row.trashed_at, row.status, row.direction, row.created_at,
		);
	}
	db.orderedIds = ROWS.map((row) => row.id);
	return db;
}

const db = openDatabase();

/** Render one criteria tree exactly as the backend does and run it against the real SQLite table. */
function matches(criteria, orderedIds = db.orderedIds) {
	const where = buildImapSearchConditions(criteria, orderedIds);
	const query = dialect.sqlToQuery(sql`select id from messages where ${where} order by id`);
	return db.prepare(query.sql).all(...query.params).map((row) => row.id);
}

/** Parse a criterion and match it, so the grammar is on the same path as the SQL it produces. */
function search(...args) {
	const parsed = parseImapSearchQuery(args);
	assert.equal(parsed.kind, "criteria", `${args.join(" ")} should parse: ${parsed.message ?? parsed.charset}`);
	return matches(parsed.criteria);
}

// ---- the parser ---------------------------------------------------------------------------------------------

test("criteria parse into the tree the combinators describe", () => {
	assert.deepEqual(parseImapSearchQuery(["ALL"]), { kind: "criteria", criteria: { kind: "all" } });
	assert.deepEqual(parseImapSearchQuery(["SUBJECT", "hello world"]), {
		kind: "criteria",
		criteria: { kind: "text", field: "subject", value: "hello world" },
	});
	// A run of keys is an implicit AND, and a one-key parenthesized list is just that key.
	assert.deepEqual(parseImapSearchQuery(["SEEN", "FLAGGED"]).criteria, {
		kind: "and",
		criteria: [{ kind: "flag", flag: "seen" }, { kind: "flag", flag: "flagged" }],
	});
	assert.deepEqual(parseImapSearchQuery(["(SEEN)"]).criteria, { kind: "flag", flag: "seen" });
	assert.deepEqual(parseImapSearchQuery(["(SEEN", "FLAGGED)"]).criteria, {
		kind: "and",
		criteria: [{ kind: "flag", flag: "seen" }, { kind: "flag", flag: "flagged" }],
	});
	// RFC 3501 fixes the arity of NOT (one key) and OR (two keys), so nesting is explicit rather than by precedence.
	assert.deepEqual(parseImapSearchQuery(["OR", "NOT", "SEEN", "FLAGGED"]).criteria, {
		kind: "or",
		left: { kind: "not", criteria: { kind: "flag", flag: "seen" } },
		right: { kind: "flag", flag: "flagged" },
	});
	// The grammar is prefix, so an OR inside a group comes first: `(OR SEEN FLAGGED)`, not `(SEEN OR FLAGGED)`.
	assert.deepEqual(parseImapSearchQuery(["NOT", "(OR", "SEEN", "FLAGGED)"]).criteria, {
		kind: "not",
		criteria: { kind: "or", left: { kind: "flag", flag: "seen" }, right: { kind: "flag", flag: "flagged" } },
	});
	// An unlabelled set is the sequence-number criterion; UID's argument is the same shape.
	assert.deepEqual(parseImapSearchQuery(["1:5"]).criteria, { kind: "position", set: "1:5" });
	assert.deepEqual(parseImapSearchQuery(["UID", "9,2"]).criteria, { kind: "position", set: "9,2" });
});

test("NOT and OR are the prefix operators the RFC grammar defines", () => {
	// OR needs two keys and NOT took the first one: the RFC grammar cannot read this, so it is refused instead of
	// guessed at. `OR NOT A B` and `NOT (OR A B)` are the two things a client can mean.
	assert.deepEqual(parseImapSearchQuery(["NOT", "SEEN", "OR", "FLAGGED"]), { kind: "error", message: "OR needs two criteria" });
	// The infix spelling `SEEN OR FLAGGED` is refused rather than read as `OR SEEN FLAGGED`: accepting both would
	// make `A B OR C` mean either `A AND B AND (C ...)` or `(A AND B) OR C`, and a wrong answer is worse than a BAD.
	assert.deepEqual(parseImapSearchQuery(["SEEN", "OR", "FLAGGED"]), { kind: "error", message: "OR needs two criteria" });
	assert.deepEqual(parseImapSearchQuery(["(SEEN", "OR", "FLAGGED)"]), { kind: "error", message: "OR needs two criteria" });
	// The implicit AND binds the whole run, so `OR FROM b TO c` is one AND-term, not an AND inside the OR.
	assert.deepEqual(parseImapSearchQuery(["SUBJECT", "a", "OR", "FROM", "b", "TO", "c"]).criteria, {
		kind: "and",
		criteria: [
			{ kind: "text", field: "subject", value: "a" },
			{ kind: "or", left: { kind: "text", field: "from", value: "b" }, right: { kind: "text", field: "to", value: "c" } },
		],
	});
});

test("criteria with no honest answer are BAD, naming themselves and the reason", () => {
	const error = (...args) => {
		const parsed = parseImapSearchQuery(args);
		assert.equal(parsed.kind, "error", `${args.join(" ")} should be refused`);
		return parsed.message;
	};
	assert.match(error("ANSWERED"), /^ANSWERED is not supported: no answered state/);
	assert.match(error("UNANSWERED"), /^UNANSWERED is not supported/);
	assert.match(error("KEYWORD", "\\Seen"), /^KEYWORD is not supported/);
	assert.match(error("UNKEYWORD", "\\Seen"), /^UNKEYWORD is not supported/);
	// HEADER would need an arbitrary header store, and there is no size column for LARGER/SMALLER.
	assert.match(error("HEADER", "Message-ID", "<x@y>"), /^HEADER is not supported/);
	assert.match(error("LARGER", "1000"), /^LARGER is not supported: no message size/);
	assert.match(error("SMALLER", "1000"), /^SMALLER is not supported: no message size/);
	assert.equal(error("BOGUS"), "BOGUS is not a supported criterion");
	// Every grammar error names what is wrong rather than silently dropping the key.
	assert.equal(error("SUBJECT"), "SUBJECT needs a string");
	assert.equal(error("SINCE"), "SINCE needs a date");
	assert.equal(error("SINCE", "31-Feb-2026"), "SINCE date 31-Feb-2026 is not DD-Mon-YYYY");
	assert.equal(error("OR"), "OR needs two criteria");
	assert.equal(error("OR", "FROM", "a"), "OR needs two criteria");
	assert.equal(error("NOT"), "NOT needs one criterion");
	assert.equal(error("UID"), "UID needs a message set");
	assert.equal(error("UID", "1:x"), "UID needs a message set");
	assert.equal(error("("), "parenthesized criteria are not closed");
	assert.equal(error("()"), "() holds no criterion");
	assert.equal(error("ALL", ")"), "unexpected )");
	assert.equal(error(), "needs at least one criterion");
});

test("a refused criterion cannot inject anything into the reply", () => {
	const parsed = parseImapSearchQuery(["a\nb\u0000c"]);
	assert.equal(parsed.kind, "error");
	assert.match(parsed.message, /^a\?b\?c is not a supported criterion$/);
	assert.equal(/[^\x20-\x7e]/.test(parsed.message), false);
	const long = parseImapSearchQuery(["x".repeat(200)]);
	assert.ok(long.message.length < 90);
});

test("CHARSET is honoured in front and refused with a NO", () => {
	// The criteria strings are already decoded UTF-8, so these two charsets are what the server can honour.
	assert.deepEqual(IMAP_SEARCH_CHARSETS, ["UTF-8", "US-ASCII"]);
	assert.deepEqual(parseImapSearchQuery(["CHARSET", "UTF-8", "ALL"]), { kind: "criteria", criteria: { kind: "all" } });
	assert.deepEqual(parseImapSearchQuery(["CHARSET", "us-ascii", "SUBJECT", "x"]).kind, "criteria");
	assert.deepEqual(parseImapSearchQuery(["CHARSET", "ISO-8859-1", "ALL"]), { kind: "charset", charset: "ISO-8859-1" });
	assert.equal(parseImapSearchQuery(["CHARSET"]).message, "CHARSET needs a name");
	// A malformed query stays BAD even when it also names an unsupported charset.
	assert.equal(parseImapSearchQuery(["CHARSET", "KOI8-R", "SUBJECT"]).message, "SUBJECT needs a string");
});

test("RECENT and NEW are empty, OLD is everything, because nothing is recent", () => {
	assert.deepEqual(parseImapSearchQuery(["RECENT"]).criteria, { kind: "empty" });
	assert.deepEqual(parseImapSearchQuery(["NEW"]).criteria, { kind: "empty" });
	assert.deepEqual(parseImapSearchQuery(["OLD"]).criteria, { kind: "all" });
	assert.deepEqual(matches({ kind: "empty" }), []);
	assert.deepEqual(matches({ kind: "all" }), db.orderedIds);
});

test("dates and sets parse the way the criteria rely on", () => {
	assert.equal(parseImapSearchDate("14-Feb-2026"), Date.UTC(2026, 1, 14));
	assert.equal(parseImapSearchDate("5-jan-2026"), Date.UTC(2026, 0, 5));
	assert.equal(parseImapSearchDate("14-Feb-2026"), parseImapSearchDate(" 14-Feb-2026 "));
	for (const value of ["31-Feb-2026", "14-Xyz-2026", "2026-02-14", "14 Feb 2026", "14-Feb-26", ""]) {
		assert.equal(parseImapSearchDate(value), null, value);
	}
	assert.equal(isImapSetSyntax("1:5,7,9:*"), true);
	assert.equal(isImapSetSyntax("1:2:3"), false);
	assert.equal(isImapSetSyntax("abc"), false);
	assert.deepEqual(resolveImapSet("1:3", 5), [1, 2, 3]);
	assert.deepEqual(resolveImapSet("3:1", 5), [1, 2, 3]);
	assert.deepEqual(resolveImapSet("*", 5), [5]);
	assert.deepEqual(resolveImapSet("4:9", 5), [4, 5]);
	assert.deepEqual(resolveImapSet("1,1:2", 5), [1, 2]);
	// A set that names no message matches nothing rather than being an error (RFC 3501 §6.4.4).
	assert.deepEqual(resolveImapSet("99", 5), []);
	assert.deepEqual(resolveImapSet("0", 5), []);
	assert.deepEqual(resolveImapSet("1:*", 0), []);
});

// ---- criterion to SQL ---------------------------------------------------------------------------------------

test("the flag criteria read the columns FETCH reports flags from", () => {
	// read, or outbound mail: exactly what imapMessageFlags() calls \Seen.
	assert.deepEqual(search("SEEN"), ["m2", "m4", "m5"]);
	assert.deepEqual(search("UNSEEN"), ["m1", "m3", "m6"]);
	assert.deepEqual(search("FLAGGED"), ["m2"]);
	assert.deepEqual(search("UNFLAGGED"), ["m1", "m3", "m4", "m5", "m6"]);
	assert.deepEqual(search("DELETED"), ["m2"]);
	assert.deepEqual(search("UNDELETED"), ["m1", "m3", "m4", "m5", "m6"]);
	assert.deepEqual(search("DRAFT"), ["m5"]);
	assert.deepEqual(search("UNDRAFT"), ["m1", "m2", "m3", "m4", "m6"]);
});

test("the text criteria are case-insensitive substrings of their own columns", () => {
	assert.deepEqual(search("SUBJECT", "INVOICE"), ["m2", "m4"]);
	assert.deepEqual(search("FROM", "shop.test"), ["m2"]);
	assert.deepEqual(search("TO", "carol"), ["m2", "m5"]);
	// Cc and Bcc are their own columns, so neither leaks into TO and BCC is searchable at all.
	assert.deepEqual(search("CC", "dave"), ["m2"]);
	assert.deepEqual(search("BCC", "secret"), ["m2"]);
	assert.deepEqual(search("TO", "dave"), []);
	// LIKE metacharacters in a term are literal: `%` and `_` must not act as wildcards.
	assert.deepEqual(search("SUBJECT", "100%"), ["m6"]);
	assert.deepEqual(search("SUBJECT", "done_2026"), ["m6"]);
	assert.deepEqual(search("SUBJECT", "doneX2026"), []);
});

test("BODY reads the body columns, TEXT reads header and body", () => {
	assert.deepEqual(search("BODY", "digest"), ["m3"]);
	// m2 has no text body, so its HTML body is the body.
	assert.deepEqual(search("BODY", "unsubscribe"), ["m2"]);
	// A term that only exists in the HTML alternative of a message that also has a text body still matches: both
	// body columns are the body.
	assert.deepEqual(search("BODY", "markup-only-token"), ["m1"]);
	// TEXT spans the subject, every address column and the body.
	assert.deepEqual(search("TEXT", "list.test"), ["m3"]);
	assert.deepEqual(search("TEXT", "secret"), ["m2"]);
	assert.deepEqual(search("TEXT", "markup-only-token"), ["m1"]);
	assert.deepEqual(search("TEXT", "digest"), ["m3"]);
	// Neither reads a header column: "Invoice" is a subject, not a body.
	assert.deepEqual(search("BODY", "invoice"), []);
	assert.deepEqual(search("TEXT", "invoice"), ["m2", "m4"]);
});

test("the date criteria are UTC day boundaries on the internal date", () => {
	assert.deepEqual(search("SINCE", "14-Feb-2026"), ["m2", "m3", "m4", "m5", "m6"]);
	assert.deepEqual(search("BEFORE", "1-Mar-2026"), ["m1", "m2"]);
	// ON is that one day, so 1 March belongs to m3 alone.
	assert.deepEqual(search("ON", "1-Mar-2026"), ["m3"]);
	assert.deepEqual(search("ON", "03-Jan-2026"), []);
	// No separate sent date is stored, so the SENT* forms read the same column (documented deviation).
	assert.deepEqual(search("SENTSINCE", "14-Feb-2026"), search("SINCE", "14-Feb-2026"));
	assert.deepEqual(search("SENTBEFORE", "1-Mar-2026"), search("BEFORE", "1-Mar-2026"));
	assert.deepEqual(search("SENTON", "1-Mar-2026"), search("ON", "1-Mar-2026"));
});

test("the sequence-set and UID criteria are positional", () => {
	// orderedIds is the mailbox in sequence order, so a position is a sequence number and a UID at once.
	assert.deepEqual(search("2:3"), ["m2", "m3"]);
	assert.deepEqual(search("*"), ["m6"]);
	assert.deepEqual(search("1:*"), db.orderedIds);
	assert.deepEqual(search("3:1"), ["m1", "m2", "m3"]);
	assert.deepEqual(search("UID", "2,4"), ["m2", "m4"]);
	assert.deepEqual(search("99"), []);
	// The set resolves against the mailbox it is searched in, so a shorter mailbox has fewer positions.
	assert.deepEqual(matches({ kind: "position", set: "3:4" }, ["m1", "m2"]), []);
	assert.deepEqual(matches({ kind: "position", set: "*" }, ["m1", "m2"]), ["m2"]);
});

test("the combinators narrow and widen exactly as they read", () => {
	assert.deepEqual(search("SUBJECT", "invoice", "FROM", "shop"), ["m2"]);
	assert.deepEqual(search("OR", "SUBJECT", "Draft", "FROM", "list.test"), ["m3", "m5"]);
	// A NULL subject counts as empty text, so a negated text criterion keeps the message with no subject.
	assert.deepEqual(search("NOT", "SUBJECT", "invoice"), ["m1", "m3", "m5", "m6"]);
	assert.deepEqual(matches({ kind: "not", criteria: { kind: "position", set: "2:3" } }), ["m1", "m4", "m5", "m6"]);
	assert.deepEqual(search("NOT", "(OR", "SUBJECT", "invoice", "FROM", "list.test)"), ["m1", "m5", "m6"]);
	// A parenthesized AND is one key, and the OR after it takes the next two keys: the run is ANDed on top.
	assert.deepEqual(parseImapSearchQuery(["(SUBJECT", "invoice", "FROM", "shop)", "OR", "DRAFT", "FLAGGED"]).criteria, {
		kind: "and",
		criteria: [
			{
				kind: "and",
				criteria: [
					{ kind: "text", field: "subject", value: "invoice" },
					{ kind: "text", field: "from", value: "shop" },
				],
			},
			{ kind: "or", left: { kind: "flag", flag: "draft" }, right: { kind: "flag", flag: "flagged" } },
		],
	});
	assert.deepEqual(search("(SUBJECT", "invoice", "FROM", "shop)", "OR", "DRAFT", "FLAGGED"), ["m2"]);
});

// ---- the protocol -------------------------------------------------------------------------------------------

const INBOX = { name: "INBOX", ref: "mbx1~inbox", mailboxId: "mbx1", role: "inbox", folderId: null, selectable: true };
const selected = { state: "selected", selected: { name: "INBOX", ref: "mbx1~inbox", uidValidity: 1, readOnly: true } };

function searchBackend(numbers = [2, 5]) {
	const calls = [];
	return {
		calls,
		client: {
			list: async () => [INBOX],
			counts: async () => ({ messages: 6, unseen: 3 }),
			messages: async () => [],
			search: async (mailbox, criteria) => {
				calls.push({ mailbox, criteria });
				return numbers;
			},
		},
	};
}

const run = (client, line, state = selected) => dispatchImapCommand(state, parseImapCommand(line), client);
const searchLines = (response) => response.split("\r\n").filter((line) => line.startsWith("* SEARCH"));

test("SEARCH and UID SEARCH answer the matching numbers and a tagged OK", async () => {
	const { client, calls } = searchBackend();
	assert.equal((await run(client, "A SEARCH ALL")).response, "* SEARCH 2 5\r\nA OK SEARCH completed\r\n");
	assert.equal((await run(client, "A UID SEARCH ALL")).response, "* SEARCH 2 5\r\nA OK UID SEARCH completed\r\n");
	// Both commands hand the backend the same tree: in this bridge a sequence number is the UID.
	assert.deepEqual(calls.map((call) => call.criteria), [{ kind: "all" }, { kind: "all" }]);
	assert.equal(calls[0].mailbox.ref, "mbx1~inbox");

	// An empty result is `* SEARCH` with no ids, then the OK: legal, and not the same as no reply.
	const empty = searchBackend([]);
	assert.equal((await run(empty.client, "A SEARCH FLAGGED")).response, "* SEARCH\r\nA OK SEARCH completed\r\n");
	assert.equal(searchLines((await run(empty.client, "A SEARCH FLAGGED")).response).length, 1);
});

test("SEARCH passes the parsed criteria through, quoted strings included", async () => {
	const { client, calls } = searchBackend();
	await run(client, 'A SEARCH SUBJECT "invoice 42" FROM shop.test');
	assert.deepEqual(calls[0].criteria, {
		kind: "and",
		criteria: [
			{ kind: "text", field: "subject", value: "invoice 42" },
			{ kind: "text", field: "from", value: "shop.test" },
		],
	});
	await run(client, "B UID SEARCH NOT (OR SEEN FLAGGED) SINCE 14-Feb-2026");
	assert.deepEqual(calls[1].criteria, {
		kind: "and",
		criteria: [
			{ kind: "not", criteria: { kind: "or", left: { kind: "flag", flag: "seen" }, right: { kind: "flag", flag: "flagged" } } },
			{ kind: "date", field: "since", start: Date.UTC(2026, 1, 14) },
		],
	});
});

test("SEARCH refuses what it cannot answer, and needs a selected mailbox", async () => {
	const { client, calls } = searchBackend();
	assert.equal((await run(client, "A SEARCH ALL", { state: "authenticated", selected: null })).response, "A BAD No mailbox selected\r\n");
	assert.equal((await run(client, "A UID SEARCH ALL", { state: "authenticated", selected: null })).response, "A BAD No mailbox selected\r\n");
	assert.equal((await run(client, "A SEARCH")).response, "A BAD SEARCH needs at least one criterion\r\n");
	assert.equal((await run(client, "A UID SEARCH")).response, "A BAD UID SEARCH needs at least one criterion\r\n");
	assert.equal(
		(await run(client, "A SEARCH ANSWERED")).response,
		"A BAD SEARCH ANSWERED is not supported: no answered state is stored (\\Answered is not advertised)\r\n",
	);
	assert.match((await run(client, "A SEARCH LARGER 1000")).response, /^A BAD SEARCH LARGER is not supported/);
	// RFC 3501 §6.4.4: an unsupported charset is a NO with BADCHARSET, not a BAD.
	assert.equal(
		(await run(client, "A SEARCH CHARSET ISO-8859-1 ALL")).response,
		"A NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset ISO-8859-1\r\n",
	);
	assert.equal((await run(client, "A SEARCH CHARSET UTF-8 ALL")).response, "* SEARCH 2 5\r\nA OK SEARCH completed\r\n");
	// A refused query must not reach the database, and must not be answered as if it matched everything.
	assert.equal(calls.length, 1);
});
