import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-imap-idle-access-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * IDLE's per-tick gate against a real database: `idleCounts` has to re-check readable access, not trust the entry
 * the IDLE resolved. A revoked shared grant, a disabled mailbox or a scoped app password must make it answer `null`
 * (which ends the IDLE without a count), while the mailbox's owner keeps reading. The socket-level half — that a
 * `null` tick ends the IDLE without an EXISTS — is `tests/imap-idle.test.mjs`.
 */
await build({
	entryPoints: {
		db: join(root, "src/db/index.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		backend: join(root, "server/runtime/imap-mailbox-backend.ts"),
		protocol: join(root, "server/runtime/imap-protocol.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { createDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const { imapMailboxBackend } = await load("backend");
const { dispatchImapCommand, parseImapCommand } = await load("protocol");

const authFor = (userId, email, overrides = {}) => ({
	userId,
	email,
	user: { id: userId, role: "member" },
	mailboxIds: null,
	keyId: "key1",
	keyKind: "app",
	scopes: [],
	...overrides,
});
const alice = authFor("u1", "alice@example.test");
const bob = authFor("u2", "bob@example.test");

/**
 * Alice owns a shared mailbox with three inbox messages and has granted Bob read-only access. Team sharing is
 * what `isTeamMailboxSharingEnabled` reads, so the license row is part of the fixture.
 */
async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const db = createDb(database);
	const now = Math.floor(Date.now() / 1000);
	const run = (sql, ...args) => database.db.prepare(sql).run(...args);
	run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'alice@example.test', 'Alice', 'x', ?)", now);
	run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u2', 'bob@example.test', 'Bob', 'x', ?)", now);
	run("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.test', 'zone', ?)", now);
	run("INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'sales', 'shared', ?)", now);
	run("INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'instance-1', 'team', 'active', ?)", now);
	run("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc1', 'mb1', 'u2', 'read_only', ?)", now);
	for (let index = 1; index <= 3; index++) {
		run(
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, created_at)
			 VALUES (?, 'u1', 'mb1', 'inbound', 'sender@example.org', 'sales@example.test', 'received', 0, ?)`,
			`msg${index}`,
			now + index,
		);
	}
	return { database, db };
}

/** The selected state IDLE needs, built from the mailbox's own catalogue entry the way SELECT would. */
async function selectInbox(backend, who) {
	const entry = (await backend.list()).find((candidate) => candidate.selectable && candidate.role === "inbox");
	assert.ok(entry, `no selectable INBOX for ${who}`);
	return { entry, session: { state: "selected", selected: { name: entry.name, ref: entry.ref, uidValidity: 1, readOnly: true } } };
}

test("a shared grant that is revoked stops IDLE's per-tick count", async (t) => {
	const { database, db } = await createFixture(t);
	const backend = imapMailboxBackend(db, bob, {});
	const { entry, session } = await selectInbox(backend, "bob");
	const action = await dispatchImapCommand(session, parseImapCommand("A1 IDLE"), backend);
	assert.equal(action.response, "+ idling\r\n");
	assert.equal(action.idle.messages, 3);
	assert.deepEqual(await backend.idleCounts(action.idle.entry), { messages: 3, unseen: 3 });

	// Revoking the grant is deleting its row, exactly what the access route does.
	database.db.prepare("DELETE FROM mailbox_access WHERE mailbox_id = 'mb1' AND user_id = 'u2'").run();
	assert.equal(await backend.idleCounts(entry), null);

	// The owner's IDLE on the same mailbox is unaffected: the check follows the grant, not the mailbox.
	const ownerBackend = imapMailboxBackend(db, alice, {});
	const owner = await selectInbox(ownerBackend, "alice");
	assert.deepEqual(await ownerBackend.idleCounts(owner.entry), { messages: 3, unseen: 3 });
});

test("a disabled mailbox and a scoped app password also stop the count", async (t) => {
	const { database, db } = await createFixture(t);
	const backend = imapMailboxBackend(db, bob, {});
	const { entry, session } = await selectInbox(backend, "bob");
	// A key scoped to a set of mailboxes does not read outside it, the same rule LIST and FETCH follow.
	const scoped = imapMailboxBackend(db, { ...bob, mailboxIds: ["other-mailbox"] }, {});
	assert.equal(await scoped.idleCounts(entry), null);
	// A disabled mailbox leaves every catalogue, owner included.
	database.db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mb1'").run();
	assert.equal(await backend.idleCounts(entry), null);
	const ownerBackend = imapMailboxBackend(db, alice, {});
	assert.equal(await ownerBackend.idleCounts(entry), null);
	assert.equal((await ownerBackend.list()).length, 0);
	// And the protocol's own IDLE entry refuses it too, rather than answering `+ idling` for a mailbox it cannot read.
	const action = await dispatchImapCommand(session, parseImapCommand("A2 IDLE"), backend);
	assert.equal(action.response, "A2 NO No such mailbox\r\n");
});

test("a grant that is still readable keeps the count, whatever it may do beyond reading", async (t) => {
	const { database, db } = await createFixture(t);
	const backend = imapMailboxBackend(db, bob, {});
	const { entry } = await selectInbox(backend, "bob");
	assert.ok(entry);
	// `send_on_behalf` is above read_only in the permission rank, so it can still read what IDLE reports.
	database.db.prepare("UPDATE mailbox_access SET permission = 'send_on_behalf' WHERE id = 'acc1'").run();
	assert.deepEqual(await backend.idleCounts(entry), { messages: 3, unseen: 3 });
});
