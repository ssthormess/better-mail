import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// F07: an envelope recipient that names an enabled mailing list fans out into
// one stored delivery per member mailbox, through the same inbound path a
// direct recipient takes.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-mailing-list-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { resolveInboundAddress } from "./src/lib/email/routing.ts";
			export { getDb } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "mailing-list-entry.ts",
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
const { SqliteDatabase, applyMigrations, intakeIncomingMail, processInboundMessage, resolveInboundAddress, getDb } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

const raw = new TextEncoder().encode("From: sender@ext.test\r\nTo: team@one.test\r\nSubject: hi\r\nMessage-ID: <1@ext.test>\r\n\r\nbody\r\n").buffer;

async function setup(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('one', 'admin', 'one.test', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('bobbox', 'admin', 'one', 'bob', 1),
			('annbox', 'admin', 'one', 'ann', 1);
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

function insertList(database, { id = "team", localPart = "team", disabled = 0, members = [] }) {
	database.db.prepare(`INSERT INTO mailing_lists (id, user_id, domain_id, local_part, name, disabled, created_at) VALUES (?, 'admin', 'one', ?, ?, ?, 1)`)
		.run(id, localPart, id, disabled);
	for (const [index, email] of members.entries()) {
		database.db.prepare(`INSERT INTO mailing_list_members (id, list_id, email, created_at) VALUES (?, ?, ?, 1)`)
			.run(`${id}-m${index}`, id, email);
	}
}

function mailByMailbox(database) {
	return database.db.prepare("SELECT mailbox_id AS mailboxId, raw_r2_key AS rawR2Key, to_addr AS toAddr, from_addr AS fromAddr, status FROM messages").all();
}

async function intake(env, to, from = "sender@ext.test") {
	return intakeIncomingMail(env, { from, to, raw, headers: {} }, {});
}

test("a list recipient fans out to every internal member mailbox, including alias members", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);
	insertList(database, { members: ["bob-alias@one.test", "ann@one.test", "ext@elsewhere.test"] });

	await intake(env, "team@one.test");
	assert.equal(queued.length, 1);
	await processInboundMessage(env, queued[0]);

	const rows = mailByMailbox(database);
	assert.deepEqual(new Set(rows.map((row) => row.mailboxId)), new Set(["bobbox", "annbox"]));
	// The alias member lands in the alias owner's mailbox; the To header keeps
	// showing the list address, like a direct recipient would store it.
	assert.ok(rows.every((row) => row.toAddr.includes("team@one.test")));
	// Each member copy is its own raw object, keyed per mailbox, so the source
	// object can be dropped and member deletes stay independent.
	assert.equal(new Set(rows.map((row) => row.rawR2Key)).size, 2);
	for (const row of rows) assert.ok(objects.has(row.rawR2Key), row.rawR2Key);
});

test("a member posting to the list does not get a copy of their own post", async (t) => {
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	await intake(env, "team@one.test", "bob@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);
});

test("a member who is also a direct envelope recipient gets exactly one copy", async (t) => {
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	// Same bytes to the member directly and to the list: intake keys each object
	// by the resolved mailbox, so the member's list copy dedupes on
	// (mailboxId, rawR2Key) instead of storing a second copy.
	await intake(env, "bob@one.test");
	await intake(env, "team@one.test");
	assert.equal(queued.length, 2);
	for (const payload of queued) await processInboundMessage(env, payload);

	const rows = mailByMailbox(database);
	assert.equal(rows.filter((row) => row.mailboxId === "bobbox").length, 1);
	assert.equal(rows.filter((row) => row.mailboxId === "annbox").length, 1);
});

test("a disabled list resolves to nothing, like a disabled mailbox", async (t) => {
	t.mock.method(console, "warn", () => {});
	const { env, database } = await setup(t);
	insertList(database, { disabled: 1, members: ["bob@one.test"] });

	assert.equal(await resolveInboundAddress(getDb(env), "team@one.test"), null);
});

test("the disabled list drops the queued message without delivering to members", async (t) => {
	t.mock.method(console, "warn", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { disabled: 1, members: ["bob@one.test"] });

	await intake(env, "team@one.test");
	await processInboundMessage(env, queued[0]);
	assert.equal(mailByMailbox(database).length, 0);
});

test("nested lists expand once each and a cycle cannot loop", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test", "bob@one.test", "ann@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", members: ["ann@one.test", "all@one.test"] });

	await intake(env, "all@one.test");
	await processInboundMessage(env, queued[0]);

	const rows = mailByMailbox(database);
	// ann reaches the delivery set twice (direct member and via eng), and the
	// eng->all back-reference is skipped: every member still gets one copy.
	assert.deepEqual(new Set(rows.map((row) => row.mailboxId)), new Set(["bobbox", "annbox"]));
	assert.equal(rows.filter((row) => row.mailboxId === "annbox").length, 1);
});

test("a member who is themselves a member of a nested list only gets one copy", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", members: ["all@one.test", "bob@one.test"] });

	await intake(env, "eng@one.test");
	await processInboundMessage(env, queued[0]);

	// eng expands into all (eng's member), which expands eng again but stops:
	// only bob is reachable without revisiting a list.
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["bobbox"]);
});

test("an exact tagged list wins over the base list for the tagged address", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "team", localPart: "team", members: ["bob@one.test"] });
	insertList(database, { id: "team-tag", localPart: "team+tag", members: ["ann@one.test"] });

	// team+tag@one.test names the literal team+tag list, not the team base.
	await intake(env, "team+tag@one.test");
	await processInboundMessage(env, queued[0]);
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);

	// And the base address still names only the base list: a stored team+tag
	// list never claims team@one.test.
	await intake(env, "team@one.test");
	await processInboundMessage(env, queued[1]);
	assert.deepEqual(
		mailByMailbox(database).map((row) => row.mailboxId).sort(),
		["annbox", "bobbox"],
	);
});

test("a tagged address falls back to the base list when no tagged list exists", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	await intake(env, "team+x@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(
		new Set(mailByMailbox(database).map((row) => row.mailboxId)),
		new Set(["bobbox", "annbox"]),
	);
});

test("an empty-tag address is literal-only for lists and never reaches the base list", async (t) => {
	t.mock.method(console, "warn", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test"] });

	// team+ carries an empty tag: only a literal team+ list could claim it, so
	// it resolves to nothing and the queued message drops with no deliveries.
	assert.equal(await resolveInboundAddress(getDb(env), "team+@one.test"), null);
	await intake(env, "team+@one.test");
	await processInboundMessage(env, queued[0]);
	assert.equal(mailByMailbox(database).length, 0);
});

test("a literal empty-tag list claims its own address", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "team-plus", localPart: "team+", members: ["bob@one.test", "ann@one.test"] });

	await intake(env, "team+@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(
		new Set(mailByMailbox(database).map((row) => row.mailboxId)),
		new Set(["bobbox", "annbox"]),
	);
});

test("a tag that is itself a plus claims the literal list first", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "team", localPart: "team", members: ["bob@one.test"] });
	insertList(database, { id: "team-plusplus", localPart: "team++", members: ["ann@one.test"] });

	// team++ has the non-empty tag '+': the literal team++ list wins over the
	// team base, like any other tagged list.
	await intake(env, "team++@one.test");
	await processInboundMessage(env, queued[0]);
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);
});

test("tags ending in a plus still fall back to the base list", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });

	// team++ (tag '+') and team+x+ (tag 'x+') are real subaddresses: with no
	// literal lists for them, the team base list claims both.
	for (const to of ["team++@one.test", "team+x+@one.test"]) {
		const decision = await resolveInboundAddress(getDb(env), to);
		assert.equal(decision?.action, "list");
		assert.equal(decision?.list?.listId, "team");
	}
	await intake(env, "team++@one.test");
	await processInboundMessage(env, queued[0]);
	assert.deepEqual(
		new Set(mailByMailbox(database).map((row) => row.mailboxId)),
		new Set(["bobbox", "annbox"]),
	);
});

test("a member copy keeps the member's own envelope address, tag and all", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	// The rules on bob's mailbox only fire if the member copy's envelope
	// recipient is the address he is subscribed with: his own bob+lists tag
	// files as spam, the list's team+x tag would file as trash.
	database.db.exec(`
		INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, match_field, match_operator, match_value, action, enabled, priority, created_at) VALUES
			('bobs-tag', 'admin', 'one', 'mailbox', 'bobbox', '', 'recipient', 'exact', 'bob+lists@one.test', 'spam', 1, 0, 1),
			('list-tag', 'admin', 'one', 'mailbox', 'bobbox', '', 'recipient', 'exact', 'team+x@one.test', 'trash', 1, 0, 1)
	`);
	insertList(database, { id: "teamx", localPart: "team+x", members: ["bob+lists@one.test", "ann@one.test"] });

	await intake(env, "team+x@one.test");
	await processInboundMessage(env, queued[0]);

	const rows = mailByMailbox(database);
	const bobs = rows.find((row) => row.mailboxId === "bobbox");
	assert.equal(bobs.status, "spam");
	assert.equal(rows.find((row) => row.mailboxId === "annbox").status, "received");
});
