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
			export { resolveInboundAddress, resolveMailboxIdentity } from "./src/lib/email/routing.ts";
			export { inboundStorageKey } from "./src/lib/email/inbound-id.ts";
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
const { SqliteDatabase, applyMigrations, intakeIncomingMail, processInboundMessage, resolveInboundAddress, resolveMailboxIdentity, inboundStorageKey, getDb } =
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
			('annbox', 'admin', 'one', 'ann', 2),
			('carolbox', 'admin', 'one', 'carol', 3);
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

function insertList(database, { id = "team", localPart = "team", postingPolicy = "members_only", moderated = 0, userId = "admin", members = [] }) {
	database.db.prepare(`INSERT INTO mailing_lists (id, user_id, domain_id, local_part, name, posting_policy, moderated, disabled, created_at) VALUES (?, ?, 'one', ?, ?, ?, ?, 0, 1)`)
		.run(id, userId, localPart, id, postingPolicy, moderated);
	for (const [index, member] of members.entries()) {
		const row = typeof member === "string" ? { email: member } : member;
		database.db.prepare(`INSERT INTO mailing_list_members (id, list_id, email, role, moderated, created_at) VALUES (?, ?, ?, ?, ?, 1)`)
			.run(`${id}-m${index}`, id, row.email, row.role ?? "member", row.moderated ?? 0);
	}
}

function mailByMailbox(database) {
	return database.db.prepare("SELECT mailbox_id AS mailboxId, raw_r2_key AS rawR2Key, status FROM messages").all();
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

test("a moderated list holds a non-owner's post for owner review", async (t) => {
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

test("a reject consumed before its sibling cannot delete the raw the sibling owns", async (t) => {
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);

	// Same bytes to bob directly and to his alias: two queue events.
	const bytes = rawFor("shared-raw");
	await intake(env, "bob@one.test", "sender@ext.test", bytes);
	await intake(env, "bob-alias@one.test", "sender@ext.test", bytes);
	assert.equal(queued.length, 2);
	// Each event stages under a private key — no shared object exists yet.
	assert.ok(queued.every((payload) => payload.rawR2Key.startsWith("inbound/staging/")));
	assert.notEqual(queued[0].rawR2Key, queued[1].rawR2Key);

	// The alias is disabled before its event is consumed, so that delivery
	// resolves to reject — the ordering the raw-loss regression lived in.
	database.db.prepare("UPDATE mailbox_aliases SET enabled = 0 WHERE id = 'bobalias'").run();
	await processInboundMessage(env, queued[1]);
	assert.equal(objects.has(queued[1].rawR2Key), false);

	// The sibling still stores; nothing its cleanup touched was shared.
	await processInboundMessage(env, queued[0]);
	const rows = mailByMailbox(database);
	assert.equal(rows.filter((row) => row.mailboxId === "bobbox").length, 1);
	assert.ok(objects.has(rows[0].rawR2Key));
	assert.ok(!rows[0].rawR2Key.startsWith("inbound/staging/"));
});

test("a reject consumed after its sibling still cannot delete the stored raw", async (t) => {
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);

	const bytes = rawFor("stored-raw");
	await intake(env, "bob@one.test", "sender@ext.test", bytes);
	await intake(env, "bob-alias@one.test", "sender@ext.test", bytes);
	database.db.prepare("UPDATE mailbox_aliases SET enabled = 0 WHERE id = 'bobalias'").run();

	// Store first: the message row now references the canonical object.
	await processInboundMessage(env, queued[0]);
	const [row] = mailByMailbox(database);
	assert.equal(row.mailboxId, "bobbox");
	assert.ok(objects.has(row.rawR2Key));

	// The reject cleanup must skip the object the stored message references.
	await processInboundMessage(env, queued[1]);
	assert.ok(objects.has(row.rawR2Key), "reject deleted an object a stored message owns");
});

test("a catch-all cannot lend a member mailbox's identity to a stranger", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { members: ["bob@one.test", "ann@one.test"] });
	// A catch-all delivers any unmatched domain address into bob's mailbox —
	// that is a delivery rule, not an identity: stranger owns no mailbox here.
	database.db.prepare("INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, match_field, match_operator, match_value, action, enabled, priority, created_at) VALUES ('catchall', 'admin', 'one', 'domain', 'bobbox', '*', 'email', 'contains', '*', 'store', 1, 0, 1)").run();

	// Mail to the stranger does reach bobbox via the catch-all…
	const delivery = await resolveInboundAddress(getDb(env), "stranger@one.test", "sender@ext.test");
	assert.equal(delivery?.mailbox?.mailboxId, "bobbox");
	// …but it is not the stranger's mailbox, so he cannot post to members_only.
	assert.equal((await resolveMailboxIdentity(getDb(env), "stranger@one.test")), null);
	const decision = await resolveInboundAddress(getDb(env), "team@one.test", "stranger@one.test");
	assert.equal(decision?.action, "reject");

	const result = await intake(env, "team@one.test", "stranger@one.test");
	assert.equal(result.action, "reject");
	assert.equal(queued.length, 0);
});

test("a catch-all sender is not wrongly held by a moderated member's flag", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		postingPolicy: "anyone",
		members: [{ email: "bob@one.test", moderated: 1 }, "ann@one.test"],
	});
	database.db.prepare("INSERT INTO routing_rules (id, user_id, domain_id, scope, mailbox_id, pattern, match_field, match_operator, match_value, action, enabled, priority, created_at) VALUES ('catchall', 'admin', 'one', 'domain', 'bobbox', '*', 'email', 'contains', '*', 'store', 1, 0, 1)").run();

	// The stranger's address catch-alls into the moderated member's mailbox,
	// but his post is not that member's post — it goes out unheld.
	const decision = await resolveInboundAddress(getDb(env), "team@one.test", "stranger@one.test");
	assert.equal(decision?.action, "list");
	assert.ok(!decision.heldForModeration);

	await intake(env, "team@one.test", "stranger@one.test");
	await processInboundMessage(env, queued[0]);
	assert.deepEqual(new Set(mailByMailbox(database).map((row) => row.mailboxId)), new Set(["bobbox", "annbox"]));
});

test("a held post with no owner member lands with the list's owning user", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		postingPolicy: "anyone",
		moderated: 1,
		members: ["ann@one.test", "carol@one.test"],
	});

	await intake(env, "team@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	// No owner-role member exists, so the held copy falls back to the list
	// owner (user admin), whose oldest mailbox on the domain is bobbox.
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["bobbox"]);
});

test("a held post with no reviewer at all is retained, never discarded", async (t) => {
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);
	// The list owner has no mailbox anywhere: nobody can receive the copy.
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('ghost', 'ghost@one.test', 'hash', 'Ghost', 'member', 0, 1)").run();
	insertList(database, {
		postingPolicy: "anyone",
		moderated: 1,
		userId: "ghost",
		members: ["ann@one.test"],
	});

	await intake(env, "team@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.equal(mailByMailbox(database).length, 0);
	assert.ok([...objects.keys()].some((key) => key.startsWith("held/team/")), "held raw must be retained");
	assert.equal(objects.has(queued[0].rawR2Key), false, "staging object is consumed");
});

test("sender suppression cannot remove the last reviewer of a held post", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		postingPolicy: "anyone",
		members: [{ email: "carol@one.test", role: "owner", moderated: 1 }, "ann@one.test"],
	});

	// carol is moderated, so her post is held; she is also the only owner —
	// echo suppression must not strip the last reviewer, so she still gets it.
	await intake(env, "team@one.test", "carol@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
});

test("an owner repost on a moderated list is not re-held", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, {
		postingPolicy: "anyone",
		moderated: 1,
		members: [{ email: "bob@one.test", role: "owner" }, "ann@one.test", "carol@one.test"],
	});

	// The list flag holds strangers' posts, not an owner's — that is what makes
	// "repost to approve" work: the owner post fans out to the full membership.
	const held = await resolveInboundAddress(getDb(env), "team@one.test", "stranger@elsewhere.test");
	assert.equal(held?.heldForModeration, true);
	const repost = await resolveInboundAddress(getDb(env), "team@one.test", "bob@one.test");
	assert.equal(repost?.action, "list");
	assert.ok(!repost.heldForModeration);

	await intake(env, "team@one.test", "bob@one.test");
	await processInboundMessage(env, queued[0]);
	assert.deepEqual(
		new Set(mailByMailbox(database).map((row) => row.mailboxId)),
		new Set(["annbox", "carolbox"]),
	);
});

test("a moderated child list with no reviewer retains the post under its own held key", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	// eng's owner has no mailbox anywhere, so the branch cannot fall back.
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('ghost', 'ghost@one.test', 'hash', 'Ghost', 'member', 0, 1)").run();
	insertList(database, { id: "all", localPart: "all", postingPolicy: "anyone", members: ["eng@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", postingPolicy: "anyone", moderated: 1, userId: "ghost", members: ["ann@one.test"] });

	// The parent accepts and is unheld; the child holds and has no owner
	// member — the branch used to be accepted then discarded entirely.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.equal(mailByMailbox(database).length, 0);
	assert.ok([...objects.keys()].some((key) => key.startsWith("held/eng/")), "held raw retained for the child");
	assert.equal(objects.has(queued[0].rawR2Key), false, "staging object is consumed");
});

test("a held child falls back to its own list's owner while ordinary siblings still deliver", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);
	// eng's owning user has a mailbox but is no member anywhere: the fallback
	// reviewer is notice-only, not a member identity.
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('mod', 'mod@one.test', 'hash', 'Mod', 'member', 0, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('modbox', 'mod', 'one', 'mod', 4);
	`);
	insertList(database, { id: "all", localPart: "all", postingPolicy: "anyone", members: ["eng@one.test", "bob@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", postingPolicy: "anyone", moderated: 1, userId: "mod", members: ["ann@one.test"] });

	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	// eng holds the stranger's post: its member ann does not get a copy, but
	// eng's owning user's mailbox does — and bob's ordinary parent copy is
	// unaffected by the hold on the sibling branch.
	assert.deepEqual(new Set(mailByMailbox(database).map((row) => row.mailboxId)), new Set(["bobbox", "modbox"]));
	assert.equal([...objects.keys()].filter((key) => key.startsWith("held/")).length, 0);
});

test("root sender suppression cannot strip a held child's only reviewer", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", postingPolicy: "anyone", members: ["eng@one.test", "carol@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", postingPolicy: "anyone", members: [{ email: "carol@one.test", role: "owner", moderated: 1 }] });

	// carol's post is held by eng (her owner row there is moderated), and she
	// is eng's only reviewer — the parent fan-out's echo suppression must
	// leave her reviewer copy standing.
	await intake(env, "all@one.test", "carol@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
});

test("a leaf reached through held and unheld paths delivers the union in either order", async (t) => {
	t.mock.method(console, "info", () => {});
	for (const engFirst of [true, false]) {
		const { env, database, queued } = await setup(t);
		// eng holds the stranger's post and reaches ops only as its owner member;
		// aux reaches ops unrestricted. ops's owner is carol, its member bob —
		// bob's copy exists only if the unrestricted path still expands ops.
		insertList(database, {
			id: "all",
			localPart: "all",
			postingPolicy: "anyone",
			members: engFirst ? ["eng@one.test", "aux@one.test"] : ["aux@one.test", "eng@one.test"],
		});
		insertList(database, { id: "eng", localPart: "eng", postingPolicy: "anyone", moderated: 1, members: [{ email: "ops@one.test", role: "owner" }] });
		insertList(database, { id: "aux", localPart: "aux", postingPolicy: "anyone", members: ["ops@one.test"] });
		insertList(database, {
			id: "ops",
			localPart: "ops",
			postingPolicy: "anyone",
			members: [{ email: "carol@one.test", role: "owner" }, "bob@one.test"],
		});

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		assert.deepEqual(
			new Set(mailByMailbox(database).map((row) => row.mailboxId)),
			new Set(["bobbox", "carolbox"]),
			`traversal order engFirst=${engFirst} changed the delivery set`,
		);
	}
});

test("a pre-staging payload consumed after the staged copy still dedupes on the canonical key", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);
	const bytes = rawFor("cross-format");

	await intake(env, "bob@one.test", "sender@ext.test", bytes);
	await processInboundMessage(env, queued[0]);
	const [row] = mailByMailbox(database);
	assert.equal(row.mailboxId, "bobbox");

	// A payload produced before staging keys existed carries the old-format
	// canonical key: its row was already stored under the new scoped key, so
	// dedupe has to look up both variants.
	const legacyKey = await inboundStorageKey(bytes, "bobbox");
	assert.notEqual(legacyKey, row.rawR2Key);
	objects.set(legacyKey, bytes);
	await processInboundMessage(env, { from: "sender@ext.test", to: "bob@one.test", rawR2Key: legacyKey });

	assert.equal(mailByMailbox(database).filter((entry) => entry.mailboxId === "bobbox").length, 1);
	assert.equal(objects.has(legacyKey), false, "the duplicate's object is consumed");
});
