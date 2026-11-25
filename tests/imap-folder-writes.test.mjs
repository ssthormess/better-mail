import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-imap-folder-writes-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * The database side of the folder writes, with the access module stubbed the way the rest of the
 * suite stubs it (see tests/message-action-service.test.mjs): `getMailboxAccessLevel` answers from
 * `globalThis.__grants`, so a test can grant full_access, a read-only share, or nothing at all.
 * Everything else — drizzle, the schema, the backend, the protocol — is the real code.
 */
await build({
	stdin: {
		contents: `export { imapMailboxBackend, listImapMailboxEntries } from "./server/runtime/imap-mailbox-backend.ts";
export { dispatchImapCommand, parseImapCommand } from "./server/runtime/imap-protocol.ts";`,
		resolveDir: root,
		sourcefile: "imap-folder-writes-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "imap-folder-writes-access",
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

const { imapMailboxBackend, listImapMailboxEntries, dispatchImapCommand, parseImapCommand } = await import(
	pathToFileURL(join(outDir, "entry.mjs")).href
);

const sqlite = new Database(":memory:");
sqlite.pragma("foreign_keys = ON");
sqlite.exec(`
	CREATE TABLE folders (
		id text PRIMARY KEY NOT NULL,
		user_id text NOT NULL,
		mailbox_id text NOT NULL,
		name text NOT NULL,
		color text NOT NULL DEFAULT '#2563eb',
		created_at integer NOT NULL
	);
	CREATE UNIQUE INDEX folders_mailbox_name_idx ON folders (mailbox_id, name);
	CREATE TABLE messages (
		id text PRIMARY KEY NOT NULL,
		mailbox_id text,
		user_id text,
		folder_id text REFERENCES folders(id) ON DELETE SET NULL,
		read integer DEFAULT 0,
		starred integer DEFAULT 0,
		status text,
		direction text,
		trashed_at integer,
		snoozed_until integer,
		private_draft integer,
		created_at integer
	);
`);
after(() => sqlite.close());

const db = drizzle(sqlite);
const OWNER = "u-owner";
const MAILBOX = { id: "mbx1", userId: OWNER, localPart: "alice", hostname: "example.test", isPrimary: true };
const auth = {
	keyId: "key1",
	keyKind: "app",
	userId: "u-delegate",
	email: "mate@example.test",
	scopes: [],
	mailboxIds: null,
	user: { id: "u-delegate", role: "member" },
};
const authenticated = { state: "authenticated", selected: null };

/** `full_access` is owner-or-delegate manage rights; anything less is a sharee who may only read. */
const grant = (permission) => {
	globalThis.__mailboxes = [MAILBOX];
	globalThis.__grants = { [MAILBOX.id]: permission };
};
const folders = () => sqlite.prepare("SELECT id, user_id, mailbox_id, name FROM folders ORDER BY name").all();
const messages = () => sqlite.prepare("SELECT id, folder_id FROM messages ORDER BY id").all();
const run = (line, session = authenticated, backend = imapMailboxBackend(db, auth)) =>
	dispatchImapCommand(session, parseImapCommand(line), backend);

beforeEach(() => {
	sqlite.exec("DELETE FROM messages; DELETE FROM folders;");
	grant("full_access");
});

test("CREATE writes a folder row owned by the mailbox owner and the next LIST sees it", async () => {
	// One backend per login, answering LIST fresh per call: that is what makes the folder visible without a reconnect.
	const backend = imapMailboxBackend(db, auth);
	const created = await run("A CREATE Reports", authenticated, backend);
	assert.equal(created.response, "A OK CREATE completed\r\n");
	const [row] = folders();
	assert.match(row.id, /^fld_/);
	assert.equal(row.user_id, OWNER);
	assert.equal(row.mailbox_id, "mbx1");
	assert.equal(row.name, "Reports");
	// REST/JMAP insert `access.mailboxUserId`; a delegate's write belongs to the owner, not the delegate.
	assert.notEqual(row.user_id, auth.userId);
	assert.equal(sqlite.prepare("SELECT color FROM folders").get().color, "#2563eb");

	const listed = (await backend.list()).map((entry) => entry.name);
	assert.ok(listed.includes("Reports"));
	// And the same fresh catalogue is what SELECT resolves, so the new folder is usable at once.
	const selected = await run("B SELECT Reports", authenticated, backend);
	assert.equal(selected.state, "selected");
	assert.equal(selected.selected.ref, `mbx1~f~${row.id}`);
	// A second CALL fills the same folder name: the catalogue check answers before the unique index has to.
	assert.equal((await run("C CREATE Reports", authenticated, backend)).response, "C NO Mailbox already exists\r\n");
	assert.equal(folders().length, 1);
});

test("CREATE stores the folder in the namespace it names", async () => {
	globalThis.__mailboxes = [MAILBOX, { id: "mbx2", userId: "u-sales", localPart: "sales", hostname: "example.test", isPrimary: false }];
	globalThis.__grants = { mbx1: "full_access", mbx2: "full_access" };
	const backend = imapMailboxBackend(db, auth);
	assert.equal((await run('A CREATE "sales@example.test/Leads"', authenticated, backend)).response, "A OK CREATE completed\r\n");
	const [row] = folders();
	assert.equal(row.mailbox_id, "mbx2");
	assert.equal(row.name, "Leads");
	assert.equal(row.user_id, "u-sales");
	assert.ok((await backend.list()).some((entry) => entry.name === "sales@example.test/Leads"));
	// A namespace this account cannot see answers exactly like a name that does not exist.
	assert.equal((await run("A CREATE elsewhere@example.test/X", authenticated, backend)).response, "A NO No such mailbox\r\n");
});

test("DELETE removes the row and unfiles its messages through the set-null foreign key", async () => {
	const backend = imapMailboxBackend(db, auth);
	await run("A CREATE Reports", authenticated, backend);
	const { id } = folders()[0];
	sqlite.prepare("INSERT INTO messages (id, mailbox_id, folder_id) VALUES ('m1', 'mbx1', ?)").run(id);
	sqlite.prepare("INSERT INTO messages (id, mailbox_id, folder_id) VALUES ('m2', 'mbx1', NULL)").run();
	assert.equal((await run("B DELETE Reports", authenticated, backend)).response, "B OK DELETE completed\r\n");
	assert.deepEqual(folders(), []);
	// The alias wants no manual unfile pass: the foreign key is `on delete set null`, the same as JMAP's plain destroy.
	assert.deepEqual(messages(), [{ id: "m1", folder_id: null }, { id: "m2", folder_id: null }]);
	assert.equal((await run("C DELETE Reports", authenticated, backend)).response, "C NO No such mailbox\r\n");
});

test("RENAME changes the name in place, so message folder refs keep pointing at the folder", async () => {
	const backend = imapMailboxBackend(db, auth);
	await run("A CREATE Reports", authenticated, backend);
	const { id } = folders()[0];
	sqlite.prepare("INSERT INTO messages (id, mailbox_id, folder_id) VALUES ('m1', 'mbx1', ?)").run(id);
	assert.equal((await run('B RENAME Reports "Quarterly Reports"', authenticated, backend)).response, "B OK RENAME completed\r\n");
	assert.deepEqual(folders().map((row) => [row.id, row.name]), [[id, "Quarterly Reports"]]);
	assert.deepEqual(messages(), [{ id: "m1", folder_id: id }]);
	// Renaming onto a name another folder already holds is refused by the catalogue, not by a throw.
	await run("C CREATE Invoices", authenticated, backend);
	assert.equal((await run('C RENAME "Quarterly Reports" Invoices', authenticated, backend)).response, "C NO Mailbox already exists\r\n");
});

test("a read-only or send-only sharee can read the folders but write none of them", async () => {
	for (const permission of ["read_only", "send_as", "send_on_behalf"]) {
		sqlite.exec("DELETE FROM folders");
		grant(permission);
		const backend = imapMailboxBackend(db, auth);
		// The catalogue still lists the mailbox's folders, so the denial is about managing, not about access.
		assert.equal(await run("A CREATE Reports", authenticated, backend).then((action) => action.response), "A NO No such mailbox\r\n");
		assert.equal(folders().length, 0, permission);
		// The same NO a name outside every namespace gets, so a sharee cannot probe for write rights.
		assert.equal((await run("A CREATE elsewhere@example.test/X", authenticated, backend)).response, "A NO No such mailbox\r\n");
	}
	// A folder that exists is still readable, and DELETE/RENAME refuse it.
	grant("read_only");
	sqlite.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld_1', ?, 'mbx1', 'Receipts', 0)").run(OWNER);
	const backend = imapMailboxBackend(db, auth);
	assert.ok((await backend.list()).some((entry) => entry.name === "Receipts"));
	assert.equal((await run("B DELETE Receipts", authenticated, backend)).response, "B NO No such mailbox\r\n");
	assert.equal((await run("C RENAME Receipts Invoices", authenticated, backend)).response, "C NO No such mailbox\r\n");
	assert.equal(folders()[0].name, "Receipts");
});

test("an API key scoped to other mailboxes cannot write into this one", async () => {
	const scoped = { ...auth, mailboxIds: ["mbx-other"] };
	const backend = imapMailboxBackend(db, scoped);
	assert.equal((await run("A CREATE Reports", authenticated, backend)).response, "A NO No such mailbox\r\n");
	assert.deepEqual(folders(), []);
	// The mailbox is not even in that key's catalogue.
	assert.deepEqual(await listImapMailboxEntries(db, scoped), []);
});
