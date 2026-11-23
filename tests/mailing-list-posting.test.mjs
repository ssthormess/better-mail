import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// F08: posting rules on top of the F07 fan-out engine. A list claim checks the
// envelope sender against the list's posting policy before delivery: members
// post, non-members on a members_only list get the same reject decision a
// block rule produces, and a moderated post is held for owner review.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-list-posting-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
			export { inboundStorageScope } from "./src/lib/email/inbound-id.ts";
			export { getDb } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "mailing-list-posting-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, intakeIncomingMail, processInboundMessage, resolveInboundAddress, inboundStorageScope, getDb } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

const raw = new TextEncoder().encode("From: sender@ext.test\r\nTo: team@one.test\r\nSubject: hi\r\nMessage-ID: <1@ext.test>\r\n\r\nbody\r\n").buffer;

function rawFor(id) {
	return new TextEncoder().encode(`From: sender@ext.test\r\nTo: team@one.test\r\nSubject: hi\r\nMessage-ID: <${id}@ext.test>\r\n\r\nbody\r\n`).buffer;
}

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('bobbox', 'admin', 'one', 'bob', 1),
			('annbox', 'admin', 'one', 'ann', 1),
			('carolbox', 'admin', 'one', 'carol', 1);
		INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, created_at) VALUES
			('bobalias', 'bobbox', 'one', 'bob-alias', 1, 1);
	`);
	const objects = new Map();
	const queued = [];
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, value) => { objects.set(key, value); },
			get: async (key) => objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null,
			head: async (key) => objects.has(key) ? {} : null,
			delete: async (key) => { objects.delete(key); },
		},
		INBOUND_QUEUE: { send: async (payload) => { queued.push(payload); } },
	};
	return { env, database, objects, queued };
}

function insertList(database, { id = "team", localPart = "team", postingPolicy = "members_only", moderated = 0, members = [] }) {
	database.db.prepare(`INSERT INTO mailing_lists (id, user_id, domain_id, local_part, name, posting_policy, moderated, disabled, created_at) VALUES (?, 'admin', 'one', ?, ?, ?, ?, 0, 1)`)
		.run(id, localPart, id, postingPolicy, moderated);
	for (const [index, member] of members.entries()) {
		const row = typeof member === "string" ? { email: member } : member;
		database.db.prepare(`INSERT INTO mailing_list_members (id, list_id, email, role, moderated, created_at) VALUES (?, ?, ?, ?, ?, 1)`)
			.run(`${id}-m${index}`, id, row.email, row.role ?? "member", row.moderated ?? 0);
	}
}

function mailByMailbox(database) {
	return database.db.prepare("SELECT mailbox_id AS mailboxId, status FROM messages").all();
}

function intake(env, to, from = "sender@ext.test", bytes = raw) {
	return intakeIncomingMail(env, { from, to, raw: bytes, headers: {} }, {});
}

test("a member posts to a members_only list and it fans out", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	const result = await intake(env, "team@one.test", "bob@one.test");
	assert.equal(result.action, "store");
	await processInboundMessage(env, queued[0]);

	// bob is the sender, so only ann receives a copy.
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);
});

test("a member posting from another address of the same mailbox still posts", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	// bob-alias is an alias of bob's mailbox, so the sender resolves to a
	// member mailbox even though no member row names it.
	for (const sender of ["bob-alias@one.test", "bob+lists@one.test"]) {
		const result = await intake(env, "team@one.test", sender, rawFor(sender));
		assert.equal(result.action, "store", sender);
		await processInboundMessage(env, queued.pop());
	}
	assert.equal(mailByMailbox(database).filter((row) => row.mailboxId === "annbox").length, 2);
});

test("an external member can post to a members_only list by member email", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["ext@elsewhere.test", "ann@one.test"] });

	const result = await intake(env, "team@one.test", "ext@elsewhere.test");
	assert.equal(result.action, "store");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);
});

test("a non-member is rejected from a members_only list like a block rule", async (t) => {
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	const decision = await resolveInboundAddress(getDb(env), "team@one.test", "sender@ext.test");
	assert.equal(decision?.action, "reject");
	assert.match(decision.rejectReason, /member/i);

	const result = await intake(env, "team@one.test", "sender@ext.test");
	assert.equal(result.action, "reject");
	assert.equal(queued.length, 0);

	// A stale or raced queue payload recomputes the decision and drops.
	objects.set("inbound/stale.eml", raw);
	await processInboundMessage(env, { from: "sender@ext.test", to: "team@one.test", rawR2Key: "inbound/stale.eml" });
	assert.equal(mailByMailbox(database).length, 0);
	assert.equal(objects.has("inbound/stale.eml"), false);
});

test("an empty envelope sender cannot post to a members_only list", async (t) => {
	t.mock.method(console, "warn", () => {});
	const { env, database } = await setup(t);
	insertList(database, { members: ["bob@one.test"] });
	assert.equal((await resolveInboundAddress(getDb(env), "team@one.test", ""))?.action, "reject");
	assert.equal((await resolveInboundAddress(getDb(env), "team@one.test", null))?.action, "reject");
});

test("anyone can post to an anyone-policy list", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { postingPolicy: "anyone", members: ["bob@one.test", "ann@one.test"] });

	const result = await intake(env, "team@one.test", "stranger@elsewhere.test");
	assert.equal(result.action, "store");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(new Set(mailByMailbox(database).map((row) => row.mailboxId)), new Set(["bobbox", "annbox"]));
});

test("a moderated member's post is held for owner review only", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		members: [
			{ email: "bob@one.test", role: "owner" },
			"ann@one.test",
			{ email: "carol@one.test", moderated: 1 },
		],
	});

	const decision = await resolveInboundAddress(getDb(env), "team@one.test", "carol@one.test");
	assert.equal(decision?.action, "list");
	assert.equal(decision.heldForModeration, true);

	const result = await intake(env, "team@one.test", "carol@one.test");
	assert.equal(result.action, "store");
	await processInboundMessage(env, queued[0]);

	// Held posts deliver to owners — the reviewers — never to members.
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["bobbox"]);
});

test("an unmoderated member posts normally on a list with moderated members", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		members: [
			{ email: "bob@one.test", role: "owner" },
			"ann@one.test",
			{ email: "carol@one.test", moderated: 1 },
		],
	});

	const decision = await resolveInboundAddress(getDb(env), "team@one.test", "ann@one.test");
	assert.equal(decision?.action, "list");
	assert.ok(!decision.heldForModeration);

	await intake(env, "team@one.test", "ann@one.test");
	await processInboundMessage(env, queued[0]);
	assert.deepEqual(new Set(mailByMailbox(database).map((row) => row.mailboxId)), new Set(["bobbox", "carolbox"]));
});

test("a moderated list holds every allowed post for owner review", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		postingPolicy: "anyone",
		moderated: 1,
		members: [{ email: "bob@one.test", role: "owner" }, "ann@one.test", "carol@one.test"],
	});

	const result = await intake(env, "team@one.test", "stranger@elsewhere.test");
	assert.equal(result.action, "store");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["bobbox"]);
});

test("a hold propagates into a nested list that would hold the post itself", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", postingPolicy: "anyone", members: ["eng@one.test"] });
	insertList(database, {
		id: "eng",
		localPart: "eng",
		postingPolicy: "anyone",
		moderated: 1,
		members: [{ email: "carol@one.test", role: "owner" }, "ann@one.test"],
	});

	// all accepts the post, but eng would hold it, so only eng's owner gets it.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
});

test("a nested members_only list still denies a non-member sender", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", postingPolicy: "anyone", members: ["eng@one.test", "bob@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", members: ["ann@one.test"] });

	// all is open, so the post is stored; the eng branch applies its own
	// members_only rule against the same sender and is skipped.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["bobbox"]);
});

test("the storage scope is the resolved mailbox or list, so the worker path dedupes like intake", async () => {
	assert.equal(inboundStorageScope({ mailbox: { mailboxId: "mb1" } }), "mb1");
	assert.equal(inboundStorageScope({ list: { listId: "l1" } }), "l1");
	assert.equal(inboundStorageScope(null), undefined);
	// A direct decision scopes by mailbox; the same member's copy through the
	// list is re-keyed by mailbox at fan-out, so the two events land on one key.
	assert.equal(inboundStorageScope({ mailbox: { mailboxId: "mb1" }, list: { listId: "l1" } }), "mb1");
});
