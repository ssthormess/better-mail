import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-imap-message-writes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * APPEND and MOVE against the real storage seam: `importMessageToMailbox` parses the MIME and writes the row,
 * so this suite runs the repository's own migrations rather than a hand-copied table — FTS, the change journal
 * and the `trashed_at` trigger are part of what an APPEND has to get right. Only the mailbox access module is
 * stubbed (the way tests/message-action-service.test.mjs stubs it): `getMailboxAccessLevel` answers from
 * `globalThis.__grants`, so a test can grant full_access, a read-only share, or nothing at all.
 */
await build({
	stdin: {
		contents: `export { imapMailboxBackend } from "./server/runtime/imap-mailbox-backend.ts";
export { dispatchImapCommand, parseImapCommand } from "./server/runtime/imap-protocol.ts";`,
		resolveDir: root,
		sourcefile: "imap-message-writes-entry.ts",
	},
	outfile: join(outDir, "runtime.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "imap-message-writes-access",
		setup(builder) {
			const namespace = "mock-mailbox-access";
			builder.onResolve({ filter: /^@\/lib\/mailboxes\/access$/ }, () => ({ path: namespace, namespace }));
			builder.onLoad({ filter: /.*/, namespace }, () => ({
				loader: "js",
				contents: `
					const PERMISSIONS = { read_only: true, send_on_behalf: true, send_as: true, full_access: true };
					export async function getMailboxAccessLevel(_db, _user, mailboxId) {
						const permission = (globalThis.__grants ?? {})[mailboxId];
						if (!permission || !PERMISSIONS[permission]) return null;
						const mailbox = (globalThis.__mailboxes ?? []).find((row) => row.id === mailboxId);
						if (!mailbox) return null;
						return {
							mailbox,
							permission,
							isOwner: false,
							canRead: true,
							canSendAs: permission !== "read_only",
							canSendOnBehalf: permission !== "read_only",
							canManage: permission === "full_access",
						};
					}
					export async function listAccessibleMailboxes() {
						const grants = globalThis.__grants ?? {};
						return (globalThis.__mailboxes ?? []).filter((row) => grants[row.id]);
					}
				`,
			}));
		},
	}],
});

// The D1 API over a local SQLite file, so `getDb(env)` inside the import seam and the backend's own drizzle
// instance read the same database — the same split a deploy has, where both go through env.DB.
await build({
	entryPoints: {
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "postal-mime"],
	logLevel: "silent",
});

const runtime = await import(pathToFileURL(join(outDir, "runtime.mjs")).href);
const { imapMailboxBackend, dispatchImapCommand, parseImapCommand } = runtime;
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "database.mjs")).href);
const { applyMigrations } = await import(pathToFileURL(join(outDir, "migrate.mjs")).href);

const database = new SqliteDatabase(join(outDir, "imap-message-writes.sqlite"));
await applyMigrations(database, join(root, "drizzle/migrations"));
after(() => database.db.close());

const sqlite = database.db;
sqlite.pragma("foreign_keys = ON");
const db = drizzle(sqlite);
// The sqlite driver has no async close, and the D1 stand-in is what the import seam sees.
const buckets = { keys: [], puts: 0 };
const env = {
	DB: database,
	BUCKET: {
		put: async (key) => {
			buckets.puts += 1;
			buckets.keys.push(key);
		},
		delete: async () => undefined,
	},
};

const OWNER = "u-owner";
const APPENDER = "u-delegate";
const MAILBOX = { id: "mbx1", userId: OWNER, localPart: "alice", hostname: "example.test", isPrimary: true };
const SALES = { id: "mbx2", userId: "u-sales", localPart: "sales", hostname: "example.test", isPrimary: false };
const auth = {
	keyId: "key1",
	keyKind: "app",
	userId: APPENDER,
	email: "mate@example.test",
	scopes: [],
	mailboxIds: null,
	user: { id: APPENDER, role: "member" },
};
const authenticated = { state: "authenticated", selected: null };

const grant = (...permissions) => {
	globalThis.__mailboxes = [MAILBOX, SALES];
	globalThis.__grants = Object.fromEntries(permissions);
};
const backend = () => imapMailboxBackend(db, auth, env);

/** The bytes of a literal, the way the socket layer hands them to the dispatcher. */
const literalOf = (raw) => {
	const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

/** A parsed command plus the literal the socket layer would have read after its `{n}` marker. */
const command = (line, raw) => {
	const parsed = parseImapCommand(line);
	assert.ok(parsed, line);
	return raw ? { ...parsed, literal: literalOf(raw) } : parsed;
};
const run = (line, { raw, session = authenticated, client = backend() } = {}) =>
	dispatchImapCommand(session, command(line, raw), client);

const message = ({ id = "offer-1", subject = "Offer", date = "Tue, 2 Feb 2021 10:00:00 +0000", extra = [] } = {}) =>
	[
		"From: Kevin <kevin@example.com>",
		"To: Iris <iris@example.org>",
		`Subject: ${subject}`,
		`Message-ID: <${id}@example.com>`,
		`Date: ${date}`,
		...extra,
		"",
		"Hello",
	].join("\r\n");

const rowFor = (id) =>
	sqlite
		.prepare(
			"SELECT id, user_id, mailbox_id, folder_id, direction, status, private_draft, read, starred, trashed_at, provider_message_id, subject, raw_r2_key, created_at FROM messages WHERE provider_message_id = ?",
		)
		.get(`<${id}@example.com>`);
const countMessages = () => sqlite.prepare("SELECT count(*) AS n FROM messages").get().n;

beforeEach(() => {
	sqlite.exec("DELETE FROM messages; DELETE FROM folders; DELETE FROM mailboxes; DELETE FROM domains; DELETE FROM users;");
	const now = Math.floor(Date.now() / 1000);
	for (const [id, email] of [[OWNER, "alice@example.test"], [APPENDER, "mate@example.test"], ["u-sales", "sales@example.test"]]) {
		sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)").run(id, email, email, now);
	}
	sqlite.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', ?, 'example.test', 'zone', ?)").run(OWNER, now);
	sqlite.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mbx1', ?, 'd1', 'alice', ?)").run(OWNER, now);
	sqlite.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mbx2', ?, 'd1', 'sales', ?)").run("u-sales", now);
	sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld_reports', ?, 'mbx1', 'Reports', ?)").run(OWNER, now);
	sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld_archive', ?, 'mbx1', 'Old Reports', ?)").run(OWNER, now);
	buckets.keys = [];
	buckets.puts = 0;
	grant(["mbx1", "full_access"], ["mbx2", "full_access"]);
});

test("APPEND stores the literal as a real message row and the next SELECT counts it", async () => {
	const client = backend();
	const appended = await run("A APPEND INBOX", { raw: message() });
	assert.equal(appended.response, "A OK APPEND completed\r\n");
	assert.equal(countMessages(), 1);
	const row = rowFor("offer-1");
	assert.equal(row.mailbox_id, "mbx1");
	assert.equal(row.folder_id, null);
	assert.equal(row.direction, "inbound");
	assert.equal(row.status, "received");
	assert.equal(row.subject, "Offer");
	assert.equal(row.private_draft, 0);
	// No flags in the command line, so the message is unseen (APPEND states the flags; nothing is defaulted).
	assert.equal(row.read, 0);
	assert.equal(row.starred, 0);
	// The seam keeps the raw MIME in the bucket and writes its key on the row.
	assert.equal(buckets.puts, 1);
	assert.equal(row.raw_r2_key, buckets.keys[0]);
	assert.match(row.raw_r2_key, /^imports\/msg_/);
	// The Date header is the arrival time when the client states no internal date.
	assert.equal(row.created_at, Math.floor(Date.parse("Tue, 2 Feb 2021 10:00:00 +0000") / 1000));

	// APPEND does not push an untagged EXISTS; a re-SELECT is what shows the new message (fresh catalogue per call).
	const inbox = await run("B SELECT INBOX", { client });
	assert.match(inbox.response, /\* 1 EXISTS/);
	assert.equal(inbox.selected.ref, "mbx1~inbox");
	assert.equal((await run("C FETCH 1 FLAGS", { client, session: inbox })).response, "* 1 FETCH (FLAGS ())\r\nC OK FETCH completed\r\n");
});

test("re-APPEND of the same Message-ID dedupes instead of writing a second row", async () => {
	const client = backend();
	const inbox = (await client.list()).find((entry) => entry.ref === "mbx1~inbox");
	const raw = literalOf(message());
	assert.equal(await client.append({ entry: inbox, flags: [], internalDate: null, raw }), "ok");
	// The seam dedupes on the Message-ID, so a second append of the same message adds nothing.
	assert.equal(await client.append({ entry: inbox, flags: [], internalDate: null, raw }), "duplicate");
	assert.equal(countMessages(), 1);
	// Over the wire that is still OK — the message *is* in the mailbox — with no invented response code.
	assert.equal((await run("B APPEND INBOX", { raw: message() })).response, "B OK APPEND completed\r\n");
	assert.equal(countMessages(), 1);
	// A different Message-ID is a different message, same bytes or not.
	assert.equal((await run("C APPEND INBOX", { raw: message({ id: "offer-2" }) })).response, "C OK APPEND completed\r\n");
	assert.equal(countMessages(), 2);
});

test("APPEND maps \\Seen and \\Flagged onto the flag columns", async () => {
	assert.equal((await run("A APPEND INBOX (\\Seen \\Flagged)", { raw: message() })).response, "A OK APPEND completed\r\n");
	const row = rowFor("offer-1");
	assert.equal(row.read, 1);
	assert.equal(row.starred, 1);
	const inbox = await run("B SELECT INBOX");
	assert.equal((await run("C FETCH 1 FLAGS", { session: inbox })).response, "* 1 FETCH (FLAGS (\\Seen \\Flagged))\r\nC OK FETCH completed\r\n");
});

test("APPEND honours the internal date and refuses a malformed one", async () => {
	assert.equal((await run('A APPEND INBOX "22-Nov-2026 18:00:00 +0000"', { raw: message() })).response, "A OK APPEND completed\r\n");
	assert.equal(rowFor("offer-1").created_at, Math.floor(Date.parse("2026-11-22T18:00:00Z") / 1000));
	// The offset is part of the value: 18:00 -0500 is 23:00 UTC.
	assert.equal((await run('B APPEND INBOX "22-Nov-2026 18:00:00 -0500"', { raw: message({ id: "offer-2" }) })).response, "B OK APPEND completed\r\n");
	assert.equal(rowFor("offer-2").created_at, Math.floor(Date.parse("2026-11-22T23:00:00Z") / 1000));
	for (const line of ['C APPEND INBOX "31-Feb-2026 18:00:00 +0000"', 'C APPEND INBOX "22-Xyz-2026 18:00:00 +0000"', 'C APPEND INBOX "soon"']) {
		assert.equal((await run(line, { raw: message({ id: "offer-3" }) })).response, "C BAD APPEND date-time is malformed\r\n", line);
	}
	assert.equal(countMessages(), 2);
});

test("APPEND files into a custom folder, and to Drafts and Sent as their own kind of row", async () => {
	const client = backend();
	assert.equal((await run("A APPEND Reports", { raw: message({ id: "filed-1" }) })).response, "A OK APPEND completed\r\n");
	const filed = rowFor("filed-1");
	assert.equal(filed.folder_id, "fld_reports");
	assert.equal(filed.status, "received");
	assert.equal(filed.direction, "inbound");
	assert.equal(filed.user_id, OWNER);

	// Drafts is a status, not a folder: the import seam's placement writes direction outbound, status draft
	// and private_draft, which is exactly what a JMAP-created draft is.
	assert.equal((await run("B APPEND Drafts (\\Draft)", { raw: message({ id: "draft-1" }) })).response, "B OK APPEND completed\r\n");
	const draft = rowFor("draft-1");
	assert.equal(draft.direction, "outbound");
	assert.equal(draft.status, "draft");
	assert.equal(draft.private_draft, 1);
	assert.equal(draft.folder_id, null);
	// Sent and Drafts mail belongs to the appender, as it does over REST (`getImportMessageUserId`).
	assert.equal(draft.user_id, APPENDER);

	assert.equal((await run("C APPEND Sent (\\Seen)", { raw: message({ id: "sent-1" }) })).response, "C OK APPEND completed\r\n");
	const sent = rowFor("sent-1");
	assert.equal(sent.direction, "outbound");
	assert.equal(sent.status, "sent");
	assert.equal(sent.private_draft, 0);
	assert.equal(sent.user_id, APPENDER);

	const draftsMailbox = await run("D SELECT Drafts", { client });
	assert.match(draftsMailbox.response, /\* 1 EXISTS/);
	const sentMailbox = await run("D SELECT Sent", { client });
	assert.match(sentMailbox.response, /\* 1 EXISTS/);
	// The Drafts row is a private draft of its author, so its own author still sees it.
	assert.equal((await run("E FETCH 1 FLAGS", { session: draftsMailbox, client })).response, "* 1 FETCH (FLAGS (\\Seen \\Draft))\r\nE OK FETCH completed\r\n");
});

test("APPEND refuses flags the destination cannot represent, and names it cannot file into", async () => {
	// \\Draft and \\Deleted are the Drafts and Trash mailboxes here, so a flag that contradicts the destination
	// is refused rather than silently dropped (and no row is written for it).
	assert.equal((await run("A APPEND INBOX (\\Draft)", { raw: message() })).response, "A NO Drafts mail is only appendable to the Drafts mailbox\r\n");
	assert.equal((await run("B APPEND INBOX (\\Deleted)", { raw: message() })).response, "B NO Deleted mail is only appendable to the Trash mailbox\r\n");
	assert.equal((await run("C APPEND Reports (\\Draft)", { raw: message() })).response, "C NO Drafts mail is only appendable to the Drafts mailbox\r\n");
	assert.equal(countMessages(), 0);
	// A name outside every namespace is what TRYCREATE is for (RFC 3501 §6.3.11).
	assert.equal((await run("D APPEND Nope", { raw: message() })).response, "D NO [TRYCREATE] No such mailbox\r\n");
	assert.equal((await run("E APPEND sales@example.test", { raw: message() })).response, "E NO [TRYCREATE] No such mailbox\r\n");
	// Unknown flags (keywords, \\Recent) have no column: they are dropped, not echoed back later.
	assert.equal((await run("F APPEND INBOX (\\Recent $label1)", { raw: message() })).response, "F OK APPEND completed\r\n");
	assert.equal(rowFor("offer-1").read, 0);
	// A command line without its literal is a protocol error, not an empty message.
	assert.equal((await run("G APPEND INBOX")).response, "G BAD APPEND needs a message literal\r\n");
	assert.equal((await run("H APPEND INBOX (\\Seen")).response, "H BAD APPEND flag list is not closed\r\n");
});

test("a read-only sharee can read the mailbox but can neither APPEND nor MOVE", async () => {
	grant(["mbx1", "read_only"]);
	const client = backend();
	assert.equal((await run("A APPEND INBOX", { raw: message(), client })).response, "A NO APPEND is not allowed on this mailbox\r\n");
	assert.equal(countMessages(), 0);
	// The mailbox still lists and selects, so the denial is about managing, not about access.
	assert.match((await run("B SELECT INBOX", { client })).response, /B OK \[READ-ONLY\] SELECT completed/);
	grant(["mbx1", "full_access"]);
	assert.equal((await run("C APPEND INBOX", { raw: message(), client })).response, "C OK APPEND completed\r\n");
	// A MOVE reads what it has to move, so it needs the same manage rights.
	grant(["mbx1", "read_only"]);
	const inbox = await run("D SELECT INBOX", { client });
	assert.equal((await run("E MOVE 1 Reports", { client, session: inbox })).response, "E NO MOVE is not allowed on this mailbox\r\n");
	assert.equal(sqlite.prepare("SELECT folder_id FROM messages").get().folder_id, null);
});

test("MOVE changes the folder id and tells the client the message left the mailbox", async () => {
	const client = backend();
	await run("A APPEND INBOX", { raw: message() });
	const inbox = await run("B SELECT INBOX", { client });
	// Same mailbox, different folder: one membership update, no new row, raw MIME untouched.
	const moved = await run("C MOVE 1 Reports", { client, session: inbox });
	assert.equal(moved.response, "* 1 EXPUNGE\r\nC OK MOVE completed\r\n");
	assert.equal(sqlite.prepare("SELECT folder_id FROM messages").get().folder_id, "fld_reports");
	assert.equal(countMessages(), 1);
	assert.equal(rowFor("offer-1").raw_r2_key, buckets.keys[0]);
	// The message is in its new folder, and INBOX is empty again.
	assert.match((await run("D SELECT INBOX", { client })).response, /\* 0 EXISTS/);
	const reports = await run("E SELECT Reports", { client });
	assert.match(reports.response, /\* 1 EXISTS/);
	// UID MOVE takes the same sequence numbers (a UID is a position here).
	assert.equal((await run('F UID MOVE 1 "Old Reports"', { client, session: reports })).response, "* 1 EXPUNGE\r\nF OK UID MOVE completed\r\n");
	assert.equal(sqlite.prepare("SELECT folder_id FROM messages").get().folder_id, "fld_archive");
	// A move to where the message already is changes nothing, so there is nothing to expunge.
	const archive = await run("G SELECT \"Old Reports\"", { client });
	assert.equal((await run("H MOVE 1 \"Old Reports\"", { client, session: archive })).response, "H OK MOVE completed\r\n");
	assert.equal(sqlite.prepare("SELECT folder_id FROM messages").get().folder_id, "fld_archive");
});

test("MOVE to a role mailbox rewrites status, and the triggers keep trashed_at right", async () => {
	const client = backend();
	await run("A APPEND INBOX", { raw: message() });
	const inbox = await run("B SELECT INBOX", { client });
	assert.equal((await run("C MOVE 1 Trash", { client, session: inbox })).response, "* 1 EXPUNGE\r\nC OK MOVE completed\r\n");
	const trashed = rowFor("offer-1");
	assert.equal(trashed.status, "trash");
	assert.equal(trashed.folder_id, null);
	// \\Deleted is `trashed_at`, which migration 0053's trigger maintains from status — MOVE never writes it.
	assert.notEqual(trashed.trashed_at, null);
	const trash = await run("D SELECT Trash", { client });
	assert.equal((await run("E FETCH 1 FLAGS", { client, session: trash })).response, "* 1 FETCH (FLAGS (\\Deleted))\r\nE OK FETCH completed\r\n");
	// Out of Trash back into a folder: the trigger clears trashed_at again.
	assert.equal((await run("F MOVE 1 Reports", { client, session: trash })).response, "* 1 EXPUNGE\r\nF OK MOVE completed\r\n");
	assert.equal(rowFor("offer-1").trashed_at, null);
});

test("MOVE refuses what the model cannot represent: cross-mailbox, and received mail into Sent", async () => {
	const client = backend();
	await run("A APPEND INBOX", { raw: message() });
	const inbox = await run("B SELECT INBOX", { client });
	// `messages.mailbox_id` is in every reader's scope, and JMAP refuses the same move.
	assert.equal((await run("C MOVE 1 sales@example.test/INBOX", { client, session: inbox })).response, "C NO MOVE cannot move mail between mailboxes\r\n");
	assert.equal((await run("D MOVE 1 Sent", { client, session: inbox })).response, "D NO Received mail cannot be moved to Sent\r\n");
	assert.equal(rowFor("offer-1").mailbox_id, "mbx1");
	assert.equal(rowFor("offer-1").status, "received");
	// A destination that does not exist is TRYCREATE; MOVE needs a selection, and an out-of-range sequence
	// set means the client's view is stale.
	assert.equal((await run("E MOVE 1 Nope", { client, session: inbox })).response, "E NO [TRYCREATE] No such mailbox\r\n");
	assert.equal((await run("F MOVE 1 Reports", { client })).response, "F BAD No mailbox selected\r\n");
	assert.equal((await run("G MOVE 2 Reports", { client, session: inbox })).response, "G BAD MOVE sequence set is malformed or out of range\r\n");
	assert.equal((await run("H MOVE 1", { client, session: inbox })).response, "H BAD MOVE needs a sequence set and a mailbox name\r\n");
	// Fenced: COPY and STORE stay unimplemented, because this slice is APPEND and MOVE only.
	assert.equal((await run("I COPY 1 Reports", { client, session: inbox })).response, "I NO Not implemented yet\r\n");
	assert.equal((await run("J STORE 1 +FLAGS (\\Seen)", { client, session: inbox })).response, "J NO Not implemented yet\r\n");
	assert.equal((await run("K UID STORE 1 +FLAGS (\\Seen)", { client, session: inbox })).response, "K NO Not implemented yet\r\n");
	assert.equal((await run("L EXPUNGE", { client, session: inbox })).response, "L NO Not implemented yet\r\n");
});

test("a MOVE that makes a visible message a draft journals the hide for other readers", async () => {
	const client = backend();
	await run("A APPEND INBOX", { raw: message() });
	const inbox = await run("B SELECT INBOX", { client });
	// INBOX mail moved into Drafts becomes a private draft: its author still sees it, nobody else does, so
	// the change feed carries the "hidden" entry JMAP writes for the same move.
	assert.equal((await run("C MOVE 1 Drafts", { client, session: inbox })).response, "* 1 EXPUNGE\r\nC OK MOVE completed\r\n");
	const row = rowFor("offer-1");
	assert.equal(row.status, "draft");
	assert.equal(row.private_draft, 1);
	const hidden = sqlite.prepare("SELECT count(*) AS n FROM jmap_changes WHERE object_id = ? AND change = 'hidden'").get(row.id).n;
	assert.equal(hidden, 1);
});
