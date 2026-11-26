import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-attachment-fts-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { messages } from "./src/db/schema/index.ts";
			export { buildSearchConditions } from "./src/lib/search/conditions.ts";
			export { hasAttachmentSearchIndex, clearAttachmentIndexProbe } from "./src/lib/search/attachment-index.ts";
			export { applyPendingMigrations } from "./src/lib/migrations/service.ts";
			export { rebuildSearchIndex } from "./src/lib/search/index-admin.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-fts-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** A migrated in-memory database with two messages and one attachment per row. */
async function fixture(t) {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await m.applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
		INSERT INTO messages (id, user_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
			('m1', 'u', 'inbound', 'maya@acme.test', 'o@one.test', 'weekly status', 'nothing relevant here', 'received', 1),
			('m2', 'u', 'inbound', 'sam@other.test', 'o@one.test', 'another note', 'nothing relevant either', 'received', 2);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES
			('a1', 'm1', 'q3.pdf', 'application/pdf', 10, 'attachments/m1/a1/q3.pdf', 1),
			('a2', 'm2', 'notes.txt', 'text/plain', 10, 'attachments/m2/a2/notes.txt', 2);
	`);
	const env = { DB: database };
	const db = m.getDb(env);
	/** Search results as sorted message ids, with the attachment index as F52 leaves it. */
	const ids = async (query) =>
		(await db.select({ id: m.messages.id }).from(m.messages).where(...m.buildSearchConditions(query, "UTC", { attachmentText: true }))).map((row) => row.id).sort();
	/** Mark an attachment extracted, the way the extraction writer does. */
	const extracted = (id, text, status = "done") =>
		database.db.prepare("UPDATE message_attachments SET extracted_text = ?, extract_status = ?, extracted_at = 3 WHERE id = ?").run(text, status, id);
	/** Rowids the attachment index currently matches: the index only, not the content table. */
	const matched = (expression) => database.db.prepare("SELECT rowid FROM attachments_fts WHERE attachments_fts MATCH ?").all(expression).map((row) => row.rowid);
	return { database, env, db, ids, extracted, matched };
}

test("a done attachment is indexed and its message is found by the attachment text", async (t) => {
	const { ids, extracted, matched } = await fixture(t);
	assert.deepEqual(await ids("quarterly"), [], "a message with no text and an unextracted attachment matches nothing");

	extracted("a1", "quarterly revenue forecast");
	assert.deepEqual(matched('"quarterly"*'), [1], "the attachment's rowid is the index docid");
	assert.deepEqual(await ids("quarterly"), ["m1"], "search finds the message that carries the attachment");
	assert.deepEqual(await ids("revenue"), ["m1"]);
	assert.deepEqual(await ids("quarter"), ["m1"], "attachment matches use the same prefix semantics as message matches");
	assert.deepEqual(await ids("quarterly nonexistentterm"), [], "every term has to appear in the same attachment");
});

test("only a done attachment is indexed", async (t) => {
	const { database, ids, extracted, matched } = await fixture(t);
	extracted("a1", "pending invoice text", "none");
	extracted("a2", "rejected invoice text", "failed");
	assert.deepEqual(await ids("invoice"), [], "a row still waiting or rejected is invisible to search");

	// A done row the parser found no text in (an image-only PDF) has nothing to match.
	extracted("a1", null, "done");
	assert.deepEqual(matched('"invoice"*'), [], "a done row with no text keeps no posting");
	assert.deepEqual(await ids("invoice"), []);

	// A row inserted already decided is indexed by the insert trigger, and the others
	// (inserted at "none") stay out of the index.
	database.db.exec(`
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, extract_status, extracted_text, created_at)
			VALUES ('a3', 'm2', 'ready.txt', 'text/plain', 10, 'attachments/m2/a3/ready.txt', 'done', 'ready statement', 3);
	`);
	assert.deepEqual(await ids("statement"), ["m2"]);
	assert.deepEqual(matched('"pending"*'), [], "the skipped and failed rows added nothing");
});

test("a status change adds or removes the text", async (t) => {
	const { ids, extracted, matched } = await fixture(t);
	extracted("a1", "old wording");
	assert.deepEqual(await ids("wording"), ["m1"]);

	// The same row indexed again: the old posting is deleted and the new one added.
	extracted("a1", "new wording");
	assert.deepEqual(matched('"old"*'), []);
	assert.deepEqual(await ids("new"), ["m1"]);
	assert.deepEqual(await ids("old"), []);

	// Extraction is only re-run on a "none" row, but a row that loses its text must
	// stop matching rather than keep a stale posting.
	extracted("a1", null);
	assert.deepEqual(matched('"new"*'), []);
	extracted("a1", "restored wording", "failed");
	assert.deepEqual(await ids("restored"), [], "a failed row is never searchable");
});

test("deleting an attachment unmatches it and leaves the message's own text", async (t) => {
	const { database, ids, extracted } = await fixture(t);
	extracted("a1", "deletable wording");
	assert.deepEqual(await ids("deletable"), ["m1"]);
	database.db.prepare("DELETE FROM message_attachments WHERE id = 'a1'").run();
	assert.deepEqual(await ids("deletable"), [], "the text went with the row");
	assert.deepEqual(await ids("weekly"), ["m1"], "the message's own index is untouched");
});

test("column filters search message columns and attachment free text", async (t) => {
	const { ids, extracted } = await fixture(t);
	extracted("a1", "quarterly revenue forecast");
	assert.deepEqual(await ids("from:maya quarterly"), ["m1"], "the column filter applies to the message, the term to its attachment");
	assert.deepEqual(await ids("from:sam quarterly"), [], "the message has to satisfy the filter itself");
	assert.deepEqual(await ids("subject:status quarterly"), ["m1"]);
	assert.deepEqual(await ids('subject:"weekly status" quarterly'), ["m1"]);
});

test("a negated term excludes a message whose attachment mentions it", async (t) => {
	const { ids, extracted } = await fixture(t);
	extracted("a1", "quarterly revenue forecast");
	extracted("a2", "quarterly headcount");
	assert.deepEqual(await ids("quarterly").then((rows) => rows), ["m1", "m2"]);
	assert.deepEqual(await ids("quarterly -revenue"), ["m2"], "the attachment that mentions revenue is excluded");
	assert.deepEqual(await ids("-revenue"), ["m2"], "a negation-only search excludes attachment matches too");
	assert.deepEqual(await ids("from:maya -revenue"), [], "a negation holds next to a column filter");
	// A negation must not take a message out for text it does not have anywhere.
	assert.deepEqual(await ids("quarterly -nonexistentterm"), ["m1", "m2"]);
});

test("a rebuild repopulates the attachment index from the stored text", async (t) => {
	const { database, env, ids, extracted } = await fixture(t);
	extracted("a1", "rebuildable wording");
	assert.deepEqual(await ids("rebuildable"), ["m1"]);

	// Stands for a restore from a backup that predates the index: the content is
	// there, the postings are not.
	database.db.exec("INSERT INTO attachments_fts(attachments_fts) VALUES ('delete-all')");
	assert.deepEqual(await ids("rebuildable"), []);

	await m.rebuildSearchIndex(env);
	assert.deepEqual(await ids("rebuildable"), ["m1"], "the rebuild reads the stored text back into the index");
});

test("a negated message term is not excused by an attachment hit", async (t) => {
	const { database, ids, extracted } = await fixture(t);
	// m1's body carries the negated term; its attachment carries the positive one. The
	// F52 gate found this returned m1 because the negation was folded into the positive
	// expression, which the attachment then satisfied on its own.
	database.db.prepare("UPDATE messages SET text_body = 'confidential planning' WHERE id = 'm1'").run();
	extracted("a1", "quarterly invoice");
	extracted("a2", "invoice for the audit");
	assert.deepEqual(await ids("invoice"), ["m1", "m2"]);
	assert.deepEqual(await ids("invoice -confidential"), ["m2"], "the message index match cannot be replaced by an attachment match");
	assert.deepEqual(await ids("invoice -quarterly"), ["m2"], "the attachment's own text still excludes it");
});

test("a rebuild indexes only eligible rows, so neither delete leaves an orphan posting", async (t) => {
	const { database, env, ids, extracted, matched } = await fixture(t);
	extracted("a1", "rebuildable wording");

	// A required lifecycle case: only the status changes, so the update trigger removes
	// the posting without a rebuild.
	database.db.prepare("UPDATE message_attachments SET extract_status = 'failed' WHERE id = 'a1'").run();
	assert.deepEqual(matched('"rebuildable"*'), []);

	// A rebuild must not read the text back in, and must not index a row the triggers skip
	// just because it holds text (a2 is at "none" with text, as a failed write can leave it).
	database.db.prepare("UPDATE message_attachments SET extracted_text = 'pendingmarker', extract_status = 'none' WHERE id = 'a2'").run();
	await m.rebuildSearchIndex(env);
	assert.deepEqual(matched('"rebuildable"*'), [], "a rebuild only reads rows the triggers would index");
	assert.deepEqual(matched('"pendingmarker"*'), [], "a row at none with stored text is not indexed by a rebuild");
	assert.deepEqual(await ids("rebuildable"), []);

	// A done row that exists when the rebuild runs: deleting it afterwards must remove
	// its posting, whichever way the row leaves. This is the gate's orphan case.
	database.db.exec(`
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, extract_status, extracted_text, created_at)
			VALUES ('a3', 'm1', 'later.txt', 'text/plain', 10, 'attachments/m1/a3/later.txt', 'done', 'later wording', 3),
			('a4', 'm1', 'pending.txt', 'text/plain', 10, 'attachments/m1/a4/pending.txt', 'none', NULL, 4);
	`);
	await m.rebuildSearchIndex(env);
	assert.equal(matched('"later"*').length, 1, "the eligible row is indexed");
	database.db.prepare("DELETE FROM message_attachments WHERE id = 'a3'").run();
	assert.deepEqual(matched('"later"*'), [], "the delete trigger removes a posting the rebuild created");

	// And a row that stops being eligible by status alone, after the rebuild that indexed it.
	await m.rebuildSearchIndex(env);
	database.db.prepare("UPDATE message_attachments SET extract_status = 'skipped' WHERE id = 'a1'").run();
	assert.deepEqual(matched('"rebuildable"*'), []);

	// A pending insert must leave the index agreeing with its content. With the attachment
	// table as external content it did not: it has no posting but the content has a row.
	database.db.exec("INSERT INTO attachments_fts(attachments_fts, rank) VALUES ('integrity-check', 1)");
});

test("search stays message-only until the attachment index migration is applied", async (t) => {
	const database = new m.SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	// The deployment window docs/deployment.md describes: the application is live, 0109 is
	// not applied yet. Naming attachments_fts there fails the whole statement.
	const beforeIndex = mkdtempSync(join(root, "node_modules", "mailflare-attachment-fts-before-"));
	t.after(() => rmSync(beforeIndex, { recursive: true, force: true }));
	cpSync(join(root, "drizzle/migrations"), beforeIndex, { recursive: true });
	rmSync(join(beforeIndex, "0109_attachment_search_index.sql"));
	await m.applyMigrations(database, beforeIndex);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
		INSERT INTO messages (id, user_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
			('m1', 'u', 'inbound', 'maya@acme.test', 'o@one.test', 'weekly status', 'nothing relevant here', 'received', 1),
			('m2', 'u', 'inbound', 'sam@other.test', 'o@one.test', 'another note', 'nothing relevant either', 'received', 2);
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, extract_status, extracted_text, created_at) VALUES
			('a1', 'm1', 'q3.pdf', 'application/pdf', 10, 'attachments/m1/a1/q3.pdf', 'done', 'quarterly invoice', 1);
	`);
	const db = m.getDb({ DB: database });
	const ids = async (query) =>
		(await db
			.select({ id: m.messages.id })
			.from(m.messages)
			.where(...m.buildSearchConditions(query, "UTC", { attachmentText: await m.hasAttachmentSearchIndex({ DB: database }) }))).map((row) => row.id).sort();

	assert.equal(await m.hasAttachmentSearchIndex({ DB: database }), false, "the index is not there yet");
	assert.deepEqual(await ids("weekly"), ["m1"], "a message-only search still answers");
	assert.deepEqual(await ids("quarterly"), [], "attachment text is not searchable yet");
	assert.deepEqual(await ids("-quarterly"), ["m1", "m2"], "the negative path degrades too");

	// The admin "Update database" path, which clears the cached miss itself.
	const applied = await m.applyPendingMigrations(database);
	assert.ok(applied.applied.includes("0109_attachment_search_index.sql"));
	assert.equal(await m.hasAttachmentSearchIndex({ DB: database }), true, "applying the migration invalidates the cached probe");
	assert.deepEqual(await ids("quarterly"), ["m1"], "the applied migration makes attachment text searchable");
	assert.deepEqual(await ids("quarterly -absentterm"), ["m1"], "and the negative path uses both indexes again");
});

test("a probe cached on one D1 session never makes a lagging session emit attachment SQL", async (t) => {
	// Two databases behind one raw binding stand for two D1 read sessions with independent
	// schema visibility: `current` has applied 0109, `lagging` has not. With read replication
	// `env.DB` is each request's session, so the answer must be per connection — a positive
	// cached on the current session was reused by the lagging one in the F52 gate's round-2
	// workerd simulation, and its SQL then failed to prepare (`no such table`), a 500 on
	// positive, negative and mixed searches.
	const current = new m.SqliteDatabase(":memory:");
	const lagging = new m.SqliteDatabase(":memory:");
	t.after(() => { current.db.close(); lagging.db.close(); });
	const beforeIndex = mkdtempSync(join(root, "node_modules", "mailflare-attachment-fts-lag-"));
	t.after(() => rmSync(beforeIndex, { recursive: true, force: true }));
	cpSync(join(root, "drizzle/migrations"), beforeIndex, { recursive: true });
	rmSync(join(beforeIndex, "0109_attachment_search_index.sql"));
	await m.applyMigrations(lagging, beforeIndex);
	await m.applyMigrations(current, join(root, "drizzle/migrations"));
	for (const database of [current, lagging]) {
		database.db.exec(`
			INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
			INSERT INTO messages (id, user_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
				('m1', 'u', 'inbound', 'maya@acme.test', 'o@one.test', 'weekly status', 'confidential planning', 'received', 1),
				('m2', 'u', 'inbound', 'sam@other.test', 'o@one.test', 'another note', 'invoice in body', 'received', 2);
			INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, extract_status, extracted_text, created_at) VALUES
				('a1', 'm1', 'q3.pdf', 'application/pdf', 10, 'attachments/m1/a1/q3.pdf', 'done', 'quarterly invoice', 1);
		`);
	}
	// The raw binding both sessions were opened from: the positive cache key under the round-1
	// design, deliberately still passed so the test would fail if it became the key again.
	const rawBinding = {};

	// A search request on an up-to-date session caches "the index exists".
	assert.equal(await m.hasAttachmentSearchIndex({ DB: current, DB_PRIMARY: rawBinding }), true);
	assert.equal(await m.hasAttachmentSearchIndex({ DB: current, DB_PRIMARY: rawBinding }), true);

	// The next request lands on a replica that has not applied 0109. Its own session says no,
	// so it serves message-only results instead of the 500 the cached positive produced.
	const db = m.getDb({ DB: lagging });
	const search = async (query) => {
		const attachmentText = await m.hasAttachmentSearchIndex({ DB: lagging, DB_PRIMARY: rawBinding });
		const statement = db.select({ id: m.messages.id }).from(m.messages).where(...m.buildSearchConditions(query, "UTC", { attachmentText }));
		return { attachmentText, sql: statement.toSQL().sql, rows: (await statement).map((row) => row.id).sort() };
	};
	for (const [query, expected] of [["invoice", ["m2"]], ["-confidential", ["m2"]], ["invoice -confidential", ["m2"]]]) {
		const result = await search(query);
		assert.equal(result.attachmentText, false, "the lagging session must not inherit the other session's answer");
		assert.doesNotMatch(result.sql, /attachments_fts/, "no attachment SQL is emitted for a session that cannot prepare it");
		// m1's attachment says "quarterly invoice", which this session cannot see yet.
		assert.deepEqual(result.rows, expected, `${query} answers from message text only`);
	}

	// For the record: had the cached positive been used, the same session throws exactly the
	// error that made the request a 500, so this is the failure the per-connection answer avoids.
	await assert.rejects(
		db.select({ id: m.messages.id }).from(m.messages).where(...m.buildSearchConditions("invoice", "UTC", { attachmentText: true })),
		(error) => /no such table: attachments_fts/.test(String(error.cause ?? error)),
	);
	// The up-to-date session keeps working, attachment text included.
	const currentDb = m.getDb({ DB: current });
	const currentIds = async (query) =>
		(await currentDb.select({ id: m.messages.id }).from(m.messages).where(...m.buildSearchConditions(query, "UTC", { attachmentText: await m.hasAttachmentSearchIndex({ DB: current }) }))).map((row) => row.id).sort();
	assert.deepEqual(await currentIds("quarterly"), ["m1"]);
});

test("a probe still in flight cannot republish an answer past a cache clear", async () => {
	// The gate's round-2 harness: a pre-clear probe that resolves after clearAttachmentIndexProbe()
	// used to write its stale answer into the replacement cache, so the next 30 seconds served
	// "no index" to a connection that could see it.
	let release;
	let probes = 0;
	const connection = { prepare: () => ({ first: () => { probes += 1; return new Promise((resolve) => { release = resolve; }); } }) };
	const inFlight = m.hasAttachmentSearchIndex({ DB: connection });
	m.clearAttachmentIndexProbe(connection);
	release({ name: "attachments_fts" });
	assert.equal(await inFlight, true, "the probe still reports what it saw");
	// The answer was not published: the same connection is probed again, not served the
	// result that the clear discarded.
	const answer = null;
	connection.prepare = () => ({ first: () => { probes += 1; return Promise.resolve(answer); } });
	assert.equal(await m.hasAttachmentSearchIndex({ DB: connection }), false);
	assert.equal(probes, 2);
	// The post-clear answer is cached normally.
	assert.equal(await m.hasAttachmentSearchIndex({ DB: connection }), false);
	assert.equal(probes, 2, "a miss is cached for a later call on the same connection");
});
