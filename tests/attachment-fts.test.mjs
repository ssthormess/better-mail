import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
	/** Search results as sorted message ids. */
	const ids = async (query) => (await db.select({ id: m.messages.id }).from(m.messages).where(...m.buildSearchConditions(query))).map((row) => row.id).sort();
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
