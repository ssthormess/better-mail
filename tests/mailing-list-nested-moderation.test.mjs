import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// F08b: nested-list moderation on the state-machine redesign. A member row
// that names a list which would hold the post is a held edge — the branch
// fans out to that list's reviewers (owner members, then its owning user,
// then retention under held/<listId>/), never to its membership. Every test
// that can run both member orders does: the redesign exists so that
// traversal order cannot change the delivery, hold or retention sets.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-nested-mod-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { processInboundMessage } from "./src/lib/email/inbound.ts";
			export { expandMailingListDeliveries } from "./src/lib/email/mailing-lists.ts";
		`,
		resolveDir: root,
		sourcefile: "mailing-list-nested-entry.ts",
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
const { SqliteDatabase, applyMigrations, getDb, intakeIncomingMail, processInboundMessage, expandMailingListDeliveries } =
	await import(pathToFileURL(join(directory, "entry.mjs")).href);

const raw = new TextEncoder().encode("From: sender@ext.test\r\nTo: all@one.test\r\nSubject: hi\r\nMessage-ID: <1@ext.test>\r\n\r\nbody\r\n").buffer;

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

function insertList(database, { id, localPart, postingPolicy = "anyone", moderated = 0, userId = "admin", members = [] }) {
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

function mailboxSet(database) {
	return new Set(mailByMailbox(database).map((row) => row.mailboxId));
}

// The traversal root expandMailingListDeliveries expects is the routing
// decision's ResolvedList — a plain record the test can state directly.
function resolvedList(id, userId = "admin") {
	return { listId: id, userId, domainId: "one", localPart: id, hostname: "one.test", name: id };
}

function heldKeys(objects) {
	return [...objects.keys()].filter((key) => key.startsWith("held/"));
}

function intake(env, to, from = "sender@ext.test", bytes = raw) {
	return intakeIncomingMail(env, { from, to, raw: bytes, headers: {} }, {});
}

test("a hold propagates into a nested list that would hold the post itself", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test"] });
	insertList(database, {
		id: "eng",
		localPart: "eng",
		moderated: 1,
		members: [{ email: "carol@one.test", role: "owner" }, "ann@one.test"],
	});

	// all accepts the post, but eng would hold it, so only eng's owner gets it.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
});

test("a nested list's moderated member row holds the sender's post on that branch", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test", "bob@one.test"] });
	// carol is a moderated member of eng: her post is held on the eng branch
	// even though eng itself is not list-moderated. bob's ordinary parent
	// copy is unaffected.
	insertList(database, {
		id: "eng",
		localPart: "eng",
		members: [{ email: "ann@one.test", role: "owner" }, { email: "carol@one.test", moderated: 1 }],
	});

	await intake(env, "all@one.test", "carol@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailboxSet(database), new Set(["annbox", "bobbox"]));
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
			members: engFirst ? ["eng@one.test", "aux@one.test"] : ["aux@one.test", "eng@one.test"],
		});
		insertList(database, { id: "eng", localPart: "eng", moderated: 1, members: [{ email: "ops@one.test", role: "owner" }] });
		insertList(database, { id: "aux", localPart: "aux", members: ["ops@one.test"] });
		insertList(database, {
			id: "ops",
			localPart: "ops",
			members: [{ email: "carol@one.test", role: "owner" }, "bob@one.test"],
		});

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		assert.deepEqual(
			mailboxSet(database),
			new Set(["bobbox", "carolbox"]),
			`traversal order engFirst=${engFirst} changed the delivery set`,
		);
	}
});

test("a diamond-shared unheld subtree delivers identically in either order", async (t) => {
	t.mock.method(console, "info", () => {});
	for (const leftFirst of [true, false]) {
		const { env, database, queued } = await setup(t);
		// left and right share leaf: whichever expands first, the leaf's
		// members deliver exactly once.
		insertList(database, {
			id: "all",
			localPart: "all",
			members: leftFirst ? ["left@one.test", "right@one.test"] : ["right@one.test", "left@one.test"],
		});
		insertList(database, { id: "left", localPart: "left", members: ["leaf@one.test", "ann@one.test"] });
		insertList(database, { id: "right", localPart: "right", members: ["leaf@one.test", "carol@one.test"] });
		insertList(database, { id: "leaf", localPart: "leaf", members: ["bob@one.test"] });

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		assert.deepEqual(
			mailboxSet(database),
			new Set(["annbox", "bobbox", "carolbox"]),
			`traversal order leftFirst=${leftFirst} changed the delivery set`,
		);
	}
});

test("a full visit to a shared leaf cannot satisfy a held branch's reviewer expansion", async (t) => {
	t.mock.method(console, "info", () => {});
	// Diamond: eng holds ann's post and reaches ops only as an owner member;
	// aux reaches ops unrestricted. ann is ops's owner — and the sender —
	// so she is the designated reviewer; bob is ops's ordinary member.
	for (const engFirst of [true, false]) {
		const { env, database, objects, queued } = await setup(t);
		insertList(database, {
			id: "all",
			localPart: "all",
			members: engFirst ? ["eng@one.test", "aux@one.test"] : ["aux@one.test", "eng@one.test"],
		});
		insertList(database, { id: "eng", localPart: "eng", moderated: 1, members: [{ email: "ops@one.test", role: "owner" }] });
		insertList(database, { id: "aux", localPart: "aux", members: ["ops@one.test"] });
		insertList(database, {
			id: "ops",
			localPart: "ops",
			members: [{ email: "ann@one.test", role: "owner" }, "bob@one.test"],
		});

		await intake(env, "all@one.test", "ann@one.test");
		await processInboundMessage(env, queued[0]);

		// aux-first used to expand ops "full" into the ordinary set, which the
		// held branch then took as done — eng's reviewer pass skipped ops, ann
		// lost her reviewer copy to suppression and the hold fell to a fallback.
		assert.deepEqual(
			mailboxSet(database),
			new Set(["annbox", "bobbox"]),
			`traversal order engFirst=${engFirst} changed the delivery set`,
		);
		assert.equal(heldKeys(objects).length, 0);
	}
});

test("a cached intermediate still supplies the held parent's dependency edge", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	// eng holds the stranger's post and reaches the unheld list u only
	// through an owner row; u's only member is the held child. aux reaches
	// u unrestricted — whichever order runs, eng's dependency on the child
	// must be replayed from u's cached expansion, not only from a live scan.
	for (const engFirst of [true, false]) {
		const { env, database, objects, queued } = await setup(t);
		database.db.exec(`
			INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('mod', 'mod@one.test', 'hash', 'Mod', 'member', 0, 1);
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('modbox', 'mod', 'one', 'mod', 4);
		`);
		insertList(database, {
			id: "all",
			localPart: "all",
			members: engFirst ? ["eng@one.test", "aux@one.test"] : ["aux@one.test", "eng@one.test"],
		});
		insertList(database, {
			id: "eng",
			localPart: "eng",
			moderated: 1,
			userId: "mod",
			members: [{ email: "u@one.test", role: "owner" }],
		});
		insertList(database, { id: "aux", localPart: "aux", members: ["u@one.test"] });
		insertList(database, { id: "u", localPart: "u", members: [{ email: "heldc@one.test", role: "owner" }] });
		insertList(database, {
			id: "heldc",
			localPart: "heldc",
			moderated: 1,
			members: [{ email: "ann@one.test", role: "owner" }],
		});

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		// Ordinary-first cached u's full expansion without its held-member
		// edge, so eng's dependency set came up empty and its fallback was
		// stored beside Ann's reviewer copy.
		assert.deepEqual(
			mailByMailbox(database).map((row) => row.mailboxId),
			["annbox"],
			`traversal order engFirst=${engFirst} changed the delivery set`,
		);
		assert.equal(heldKeys(objects).length, 0);
	}
});

test("two held parents sharing one held child both get its reviewers", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, objects, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["h1@one.test", "h2@one.test"] });
	insertList(database, { id: "h1", localPart: "h1", moderated: 1, members: [{ email: "h3@one.test", role: "owner" }] });
	insertList(database, { id: "h2", localPart: "h2", moderated: 1, members: [{ email: "h3@one.test", role: "owner" }] });
	insertList(database, { id: "h3", localPart: "h3", moderated: 1, members: [{ email: "carol@one.test", role: "owner" }] });

	// h3 holds the stranger's post for both parents; whoever expanded h3
	// first must not consume its reviewer set on behalf of the other.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
	assert.equal(heldKeys(objects).length, 0);
});

test("a moderated child list with no reviewer retains the post under its own held key", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	// eng's owner has no mailbox anywhere, so the branch cannot fall back.
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('ghost', 'ghost@one.test', 'hash', 'Ghost', 'member', 0, 1)").run();
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", moderated: 1, userId: "ghost", members: ["ann@one.test"] });

	// The parent accepts and is unheld; the child holds and has no owner
	// member — the branch used to be accepted then discarded entirely.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.equal(mailByMailbox(database).length, 0);
	assert.ok(heldKeys(objects).some((key) => key.startsWith("held/eng/")), "held raw retained for the child");
	assert.equal(objects.has(queued[0].rawR2Key), false, "staging object is consumed");
});

test("two nested holds with no reviewer retain under each holding list's own key", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('ghost', 'ghost@one.test', 'hash', 'Ghost', 'member', 0, 1)").run();
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test", "ops@one.test", "bob@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", moderated: 1, userId: "ghost", members: ["ann@one.test"] });
	insertList(database, { id: "ops", localPart: "ops", moderated: 1, userId: "ghost", members: ["carol@one.test"] });

	// eng and ops both hold and neither can name a reviewer — the post is
	// retained once per holding list, keyed under that list's own id.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["bobbox"]);
	assert.ok(heldKeys(objects).some((key) => key.startsWith("held/eng/")), "held raw retained for eng");
	assert.ok(heldKeys(objects).some((key) => key.startsWith("held/ops/")), "held raw retained for ops");
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
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test", "bob@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", moderated: 1, userId: "mod", members: ["ann@one.test"] });

	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	// eng holds the stranger's post: its member ann does not get a copy, but
	// eng's owning user's mailbox does — and bob's ordinary parent copy is
	// unaffected by the hold on the sibling branch.
	assert.deepEqual(mailboxSet(database), new Set(["bobbox", "modbox"]));
	assert.equal(heldKeys(objects).length, 0);
});

test("root sender suppression cannot strip a held child's only reviewer", async (t) => {
	t.mock.method(console, "info", () => {});
	const { env, database, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["eng@one.test", "carol@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", members: [{ email: "carol@one.test", role: "owner", moderated: 1 }] });

	// carol's post is held by eng (her owner row there is moderated), and she
	// is eng's only reviewer — the parent fan-out's echo suppression must
	// leave her reviewer copy standing.
	await intake(env, "all@one.test", "carol@one.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
});

test("a held list reached too deep is still handled by a later shallow path", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	// eng sits at depth 5 through the c1..c4 chain — over the expansion cap —
	// and at depth 1 as a direct member. Whichever path runs first, eng's
	// hold must be evaluated at the depth that can actually expand it.
	for (const deepFirst of [true, false]) {
		const { env, database, objects, queued } = await setup(t);
		insertList(database, {
			id: "all",
			localPart: "all",
			members: deepFirst ? ["c1@one.test", "eng@one.test"] : ["eng@one.test", "c1@one.test"],
		});
		insertList(database, { id: "c1", localPart: "c1", members: ["c2@one.test"] });
		insertList(database, { id: "c2", localPart: "c2", members: ["c3@one.test"] });
		insertList(database, { id: "c3", localPart: "c3", members: ["c4@one.test"] });
		insertList(database, { id: "c4", localPart: "c4", members: ["eng@one.test"] });
		insertList(database, { id: "eng", localPart: "eng", moderated: 1, members: [{ email: "carol@one.test", role: "owner" }] });

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		assert.deepEqual(
			mailByMailbox(database).map((row) => row.mailboxId),
			["carolbox"],
			`traversal order deepFirst=${deepFirst} changed the outcome`,
		);
		assert.equal(heldKeys(objects).length, 0);
	}
});

test("a held list reachable only past the depth cap is retained", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	insertList(database, { id: "all", localPart: "all", members: ["c1@one.test"] });
	insertList(database, { id: "c1", localPart: "c1", members: ["c2@one.test"] });
	insertList(database, { id: "c2", localPart: "c2", members: ["c3@one.test"] });
	insertList(database, { id: "c3", localPart: "c3", members: ["c4@one.test"] });
	insertList(database, { id: "c4", localPart: "c4", members: ["eng@one.test"] });
	insertList(database, { id: "eng", localPart: "eng", moderated: 1, members: [{ email: "carol@one.test", role: "owner" }] });

	// eng's reviewers exist but sit one level beyond the cap, so the hold
	// retains rather than fabricating a delivery it cannot complete.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.equal(mailByMailbox(database).length, 0);
	assert.ok(heldKeys(objects).some((key) => key.startsWith("held/eng/")), "held raw retained for the capped child");
});

test("a depth-eligible held parent's fallback waits for its held child to settle", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	// heldp holds the stranger's post at depth 4 and reaches the held child
	// only at depth 5 — past the cap — while a shallow branch reaches it at
	// depth 2. The child is the parent's only designated reviewer source, so
	// once it settles the parent's fallback must never have existed.
	for (const deepFirst of [true, false]) {
		const { env, database, objects, queued } = await setup(t);
		database.db.exec(`
			INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('mod', 'mod@one.test', 'hash', 'Mod', 'member', 0, 1);
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('modbox', 'mod', 'one', 'mod', 4);
		`);
		insertList(database, {
			id: "all",
			localPart: "all",
			members: deepFirst ? ["a1@one.test", "b1@one.test"] : ["b1@one.test", "a1@one.test"],
		});
		insertList(database, { id: "a1", localPart: "a1", members: ["a2@one.test"] });
		insertList(database, { id: "a2", localPart: "a2", members: ["a3@one.test"] });
		insertList(database, { id: "a3", localPart: "a3", members: ["heldp@one.test"] });
		insertList(database, { id: "b1", localPart: "b1", members: ["heldc@one.test"] });
		insertList(database, {
			id: "heldp",
			localPart: "heldp",
			moderated: 1,
			userId: "mod",
			members: [{ email: "heldc@one.test", role: "owner" }],
		});
		insertList(database, {
			id: "heldc",
			localPart: "heldc",
			moderated: 1,
			members: [{ email: "ann@one.test", role: "owner" }],
		});

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		// Deep-first used to finalize heldp's fallback (modbox) before heldc
		// could settle at its eligible reach, leaving a spurious notice copy
		// beside Ann's reviewer copy.
		assert.deepEqual(
			mailByMailbox(database).map((row) => row.mailboxId),
			["annbox"],
			`traversal order deepFirst=${deepFirst} changed the delivery set`,
		);
		assert.equal(heldKeys(objects).length, 0);
	}
});

test("a moderated list cycle does not manufacture a fallback beside a real reviewer", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('mod', 'mod@one.test', 'hash', 'Mod', 'member', 0, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('modbox', 'mod', 'one', 'mod', 4);
	`);
	insertList(database, { id: "all", localPart: "all", members: ["alpha@one.test"] });
	insertList(database, {
		id: "alpha",
		localPart: "alpha",
		moderated: 1,
		userId: "admin",
		members: [{ email: "ann@one.test", role: "owner" }, { email: "beta@one.test", role: "owner" }],
	});
	insertList(database, {
		id: "beta",
		localPart: "beta",
		moderated: 1,
		userId: "mod",
		members: [{ email: "alpha@one.test", role: "owner" }],
	});

	// Reaching alpha again inside beta's compute is a cycle re-entry — an
	// in-progress expansion, not an empty reviewer set. Both records fold to
	// the same fixed point: Ann, the only reviewer the cycle can produce.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);
	assert.equal(heldKeys(objects).length, 0);
});

test("a held root on a moderation cycle registers its own reviewer record", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('mod', 'mod@one.test', 'hash', 'Mod', 'member', 0, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('modbox', 'mod', 'one', 'mod', 4);
	`);
	insertList(database, {
		id: "alpha",
		localPart: "alpha",
		moderated: 1,
		userId: "admin",
		members: [{ email: "ann@one.test", role: "owner" }, { email: "beta@one.test", role: "owner" }],
	});
	insertList(database, {
		id: "beta",
		localPart: "beta",
		moderated: 1,
		userId: "mod",
		members: [{ email: "alpha@one.test", role: "owner" }],
	});

	// The addressed list itself holds the post: beta's cycle back to alpha
	// must dep on alpha's real scan — owner Ann included — not a record that
	// never computed, or alpha retains under held/ and beta invents a
	// fallback beside the reviewer alpha already has.
	await intake(env, "alpha@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["annbox"]);
	assert.equal(heldKeys(objects).length, 0);
});

test("a moderated cycle with no reviewer falls back per held branch", async (t) => {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const { env, database, objects, queued } = await setup(t);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('mod', 'mod@one.test', 'hash', 'Mod', 'member', 0, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('modbox', 'mod', 'one', 'mod', 4);
	`);
	insertList(database, { id: "all", localPart: "all", members: ["alpha@one.test"] });
	insertList(database, {
		id: "alpha",
		localPart: "alpha",
		moderated: 1,
		userId: "admin",
		members: [{ email: "beta@one.test", role: "owner" }],
	});
	insertList(database, {
		id: "beta",
		localPart: "beta",
		moderated: 1,
		userId: "mod",
		members: [{ email: "alpha@one.test", role: "owner" }],
	});

	// Neither list can enumerate a member reviewer — the cycle is the whole
	// membership — so each held branch lands its own notice with its owning
	// user instead of one inheriting the other's fallback.
	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	assert.deepEqual(mailboxSet(database), new Set(["bobbox", "modbox"]));
	assert.equal(heldKeys(objects).length, 0);
});

test("a member row naming a list under a held root still expands the branch", async (t) => {
	t.mock.method(console, "info", () => {});
	// When the addressed list itself holds the post, an owner member row that
	// names an unheld list contributes that list's owner members to the
	// reviewer set — the restricted scan still traverses its owner edges.
	const { env, database, queued } = await setup(t);
	insertList(database, {
		id: "all",
		localPart: "all",
		moderated: 1,
		members: [{ email: "ops@one.test", role: "owner" }],
	});
	insertList(database, {
		id: "ops",
		localPart: "ops",
		members: [{ email: "carol@one.test", role: "owner" }, "bob@one.test", "ann@one.test"],
	});

	await intake(env, "all@one.test", "stranger@elsewhere.test");
	await processInboundMessage(env, queued[0]);

	// Only ops's owner is a reviewer of the held root — bob and ann are not
	// owner members anywhere on this branch.
	assert.deepEqual(mailByMailbox(database).map((row) => row.mailboxId), ["carolbox"]);
});

test("an unheld member list inside a held branch joins reviewers only through an owner row", async (t) => {
	t.mock.method(console, "info", () => {});
	for (const ownerRow of [true, false]) {
		const { env, database, queued } = await setup(t);
		insertList(database, {
			id: "all",
			localPart: "all",
			moderated: 1,
			members: [{ email: "ops@one.test", role: ownerRow ? "owner" : "member" }, { email: "carol@one.test", role: "owner" }],
		});
		insertList(database, { id: "ops", localPart: "ops", members: [{ email: "ann@one.test", role: "owner" }, "bob@one.test"] });

		await intake(env, "all@one.test", "stranger@elsewhere.test");
		await processInboundMessage(env, queued[0]);

		// The restricted scan sees only owner rows: a member-role row naming
		// ops is invisible to the hold, while the same row as owner folds
		// ops's owner into the reviewer set (bob stays out either way).
		assert.deepEqual(
			mailboxSet(database),
			ownerRow ? new Set(["annbox", "carolbox"]) : new Set(["carolbox"]),
			`ownerRow=${ownerRow} changed the reviewer set`,
		);
	}
});

test("an incomplete child result poisons every ancestor that consumed it", async (t) => {
	const { database } = await setup(t);
	// A->B->A where a moderates the sender: b's edge back into a's live
	// compute is a held re-entry the cycle guard cuts, so b settles
	// incomplete — and a cannot cache itself complete on top of the
	// truncated branch it consumed. x reaches b through a second edge:
	// the cached hit on b's flagged result must poison x the same way a
	// live compute would.
	insertList(database, { id: "a", localPart: "a", moderated: 1, members: ["b@one.test", "x@one.test"] });
	insertList(database, { id: "b", localPart: "b", members: ["a@one.test"] });
	insertList(database, { id: "x", localPart: "x", members: ["b@one.test"] });
	const db = getDb({ DB: database });

	const expansion = await expandMailingListDeliveries(db, resolvedList("a"), "stranger@ext.test");
	assert.equal(expansion.complete, false);
});

test("every ancestor above a depth-capped edge reports incomplete", async (t) => {
	const { database } = await setup(t);
	insertList(database, { id: "a", localPart: "a", members: ["c1@one.test"] });
	insertList(database, { id: "c1", localPart: "c1", members: ["c2@one.test"] });
	insertList(database, { id: "c2", localPart: "c2", members: ["c3@one.test"] });
	insertList(database, { id: "c3", localPart: "c3", members: ["c4@one.test"] });
	insertList(database, { id: "c4", localPart: "c4", members: ["deep@one.test"] });
	insertList(database, { id: "deep", localPart: "deep", members: ["bob@one.test"] });
	const db = getDb({ DB: database });

	// deep sits at depth 5, one level past the cap: c4's edge is cut and
	// the incomplete flag has to walk the whole chain back to the root —
	// on a linear chain the root flag can only be false if every ancestor
	// propagated it.
	const expansion = await expandMailingListDeliveries(db, resolvedList("a"), "stranger@ext.test");
	assert.equal(expansion.complete, false);
	assert.deepEqual(expansion.skipped, [{ email: "deep@one.test", reason: "too-deep" }]);
});

test("the root stays incomplete and is never served as a cached complete", async (t) => {
	const { database } = await setup(t);
	// The gate's explicit assertion: the A->B->A hold cycle leaves the
	// root flag downgraded — and a second query on a must not get a
	// cached-complete answer. The traversal cache lives inside one
	// expansion, so the second call recomputes and has to land on the
	// same flagged-incomplete result.
	insertList(database, { id: "a", localPart: "a", moderated: 1, members: ["b@one.test"] });
	insertList(database, { id: "b", localPart: "b", members: ["a@one.test"] });
	const db = getDb({ DB: database });

	const first = await expandMailingListDeliveries(db, resolvedList("a"), "stranger@ext.test");
	const second = await expandMailingListDeliveries(db, resolvedList("a"), "stranger@ext.test");
	assert.equal(first.complete, false);
	assert.equal(second.complete, false);

	// Control: a complete graph still reports complete — the flag is not
	// unconditionally poisoned.
	insertList(database, { id: "plain", localPart: "plain", members: ["bob@one.test", "leaf@one.test"] });
	insertList(database, { id: "leaf", localPart: "leaf", members: ["ann@one.test"] });
	const healthy = await expandMailingListDeliveries(db, resolvedList("plain"), "stranger@ext.test");
	assert.equal(healthy.complete, true);
});

test("a plain cycle re-entry flags blocked cycle even when the result can serve", async (t) => {
	const { database } = await setup(t);
	// A->B->A with no moderation: a is both in-flight and already stored,
	// so b's back-edge hits the cache inside a live compute. The in-flight
	// result may still serve its content, but the edge must carry
	// blocked:"cycle" — without the flag nothing poisons and the root
	// reports a truncated branch as fully verified.
	insertList(database, { id: "a", localPart: "a", members: ["b@one.test"] });
	insertList(database, { id: "b", localPart: "b", members: ["a@one.test"] });
	const db = getDb({ DB: database });

	const expansion = await expandMailingListDeliveries(db, resolvedList("a"), "stranger@ext.test");
	assert.equal(expansion.complete, false);
	// blocked:"cycle" on the unheld back-edge reports the member row as
	// already-expanded — the observable evidence the cycle was flagged.
	assert.deepEqual(expansion.skipped, [{ email: "a@one.test", reason: "already-expanded" }]);
});
