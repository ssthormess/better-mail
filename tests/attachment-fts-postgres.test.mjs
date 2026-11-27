import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-attachment-fts-pg-"));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.MAILFLARE_DB_DIALECT = "postgres";
await build({
	stdin: {
		contents: `
			export { and } from "drizzle-orm";
			export { openExternalDatabase } from "./src/db/external.ts";
			export { resolveDatabaseConfig } from "./src/db/dialect.ts";
			export { applyPendingMigrations } from "./src/lib/migrations/service.ts";
			export { buildSearchConditions } from "./src/lib/search/conditions.ts";
			export { buildTsQueryFreeTextMatch, buildTsQueryNegation, parseSearchQuery } from "./src/lib/search/query-utils.ts";
			export { hasAttachmentSearchIndex, clearAttachmentIndexProbe } from "./src/lib/search/attachment-index.ts";
			export { getDb, schema } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-fts-pg-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { and, openExternalDatabase, resolveDatabaseConfig, applyPendingMigrations, buildSearchConditions, buildTsQueryFreeTextMatch, buildTsQueryNegation, parseSearchQuery, hasAttachmentSearchIndex, clearAttachmentIndexProbe, getDb, schema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/**
 * A real PostgreSQL (PGlite) with the migration chain applied: 0041 creates the partial
 * GIN index the queries here must answer. The rows only need the searchable columns;
 * session_replication_role=replica keeps triggers and foreign keys out of the fixture.
 */
const DB = openExternalDatabase(resolveDatabaseConfig({ DATABASE_URL: "pglite://memory" }), true);
await applyPendingMigrations(DB);
await DB.prepare("SET session_replication_role = replica").run();
const db = getDb({ DB });
const message = { userId: "u1", mailboxId: "mb1", direction: "inbound", fromAddr: "x@y.test", toAddr: "a@x.test", status: "received" };
await db.insert(schema.messages).values([
	{ ...message, id: "m_body", subject: "plain note", textBody: "a body hit for quarterword", fromAddr: "y@z.test" },
	{ ...message, id: "m_att", subject: "nothing here", textBody: "nothing relevant" },
	{ ...message, id: "m_pending", subject: "nothing here", textBody: "nothing relevant" },
	{ ...message, id: "m_mixed", subject: "nothing here", textBody: "the message says secretterm" },
]);
const attachment = { contentType: "text/plain", size: 10, disposition: "attachment" };
await db.insert(schema.messageAttachments).values([
	{ ...attachment, id: "a_done", messageId: "m_att", filename: "statement.txt", r2Key: "r/a_done", extractStatus: "done", extractedText: "quarterword revenue statement" },
	{ ...attachment, id: "a_pending", messageId: "m_pending", filename: "draft.txt", r2Key: "r/a_pending", extractStatus: "none", extractedText: "pendingword text" },
	{ ...attachment, id: "a_mixed", messageId: "m_mixed", filename: "notes.txt", r2Key: "r/a_mixed", extractStatus: "done", extractedText: "bothword in attachment" },
]);

const attachmentText = await hasAttachmentSearchIndex({ DB });
const ids = async (query, options = { attachmentText }) =>
	(await db.select({ id: schema.messages.id }).from(schema.messages).where(and(...buildSearchConditions(query, "UTC", options)))).map((row) => row.id).sort();
/** The parameterized form of the conditions, to prove terms are bound, not interpolated. */
const compiled = (query, options = { attachmentText }) =>
	db.select({ id: schema.messages.id }).from(schema.messages).where(and(...buildSearchConditions(query, "UTC", options))).toSQL();

test("the migration creates the partial GIN index the probe looks for", async () => {
	assert.equal(attachmentText, true);
	const found = await DB.prepare(
		"SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'message_attachments_extracted_text_fts_idx'",
	).first();
	assert.match(found.indexdef, /USING gin \(to_tsvector\('simple'::regconfig, extracted_text\)\)/i, "the index is a GIN over the tsvector expression");
	assert.match(found.indexdef, /WHERE.*extract_status = 'done'.*extracted_text IS NOT NULL/i, "the index is partial over the eligible set");
});

test("free text matches the message or one of its eligible attachments", async () => {
	assert.deepEqual(await ids("quarterword"), ["m_att", "m_body"], "the message body and the attachment text both answer the term");
	assert.deepEqual(await ids("quarterw"), ["m_att", "m_body"], "terms match by prefix, like the FTS5 'term'* form");
	assert.deepEqual(await ids('"revenue statement"'), ["m_att"], "quoted text is an adjacent-words phrase");
	assert.deepEqual(await ids("quarterword absentterm"), [], "every positive term must appear in the same row");
	assert.deepEqual(await ids("subject:note quarterw"), ["m_body"], "column filters stay message-only");
	assert.deepEqual(await ids("from:x quarterword"), ["m_att"], "a from: filter is satisfied by the message while text hits its attachment");
});

test("the eligible set is the done+nonnull rows the SQLite view selects", async () => {
	assert.deepEqual(await ids("pendingword"), [], "a 'none' row is invisible even though it carries text");
	assert.deepEqual(await ids("statement"), ["m_att"], "a done row with text is indexed");
});

test("a negated term is rejected against the message and its attachments", async () => {
	assert.deepEqual(await ids("-quarterword"), ["m_mixed", "m_pending"], "both the body hit and the attachment hit are excluded");
	assert.deepEqual(await ids("bothword -secretterm"), [], "the negation on the message side is not excused by the attachment hit");
	assert.deepEqual(await ids("quarterword -revenue"), ["m_body"], "the attachment matching revenue is rejected");
});

test("the tsquery expression is bound as a parameter, not interpolated", async () => {
	const { sql, params } = await compiled('quarterw "revenue statement" -badterm');
	assert.match(sql, /to_tsvector\('simple', "message_attachments"\."extracted_text"\) @@ to_tsquery\('simple', \$[0-9]+\)/, "the match is a parameterized tsquery");
	assert.ok(!sql.includes("quarterw") && !sql.includes("badterm"), "no term text appears in the SQL itself");
	assert.ok(params.includes("quarterw:* & (revenue <-> statement)"), "the ANDed positive expression is a bound parameter");
	assert.ok(params.includes("badterm:*"), "the negated term is a bound parameter");
	assert.equal(buildTsQueryFreeTextMatch(parseSearchQuery('quarterw "revenue statement"', "UTC")), "quarterw:* & (revenue <-> statement)");
	assert.equal(buildTsQueryNegation(parseSearchQuery("x -badterm -\"two words\"", "UTC")), "badterm:* | (two <-> words)");
});

test("without the index the search degrades to the message-only LIKE scan", async () => {
	await DB.prepare('DROP INDEX "message_attachments_extracted_text_fts_idx"').run();
	clearAttachmentIndexProbe(DB);
	assert.equal(await hasAttachmentSearchIndex({ DB }), false, "the probe notices the missing index");
	assert.deepEqual(await ids("quarterword", { attachmentText: false }), ["m_body"], "pre-migration search is message-only");
	assert.deepEqual(await ids("quarterword", { attachmentText: await hasAttachmentSearchIndex({ DB }) }), ["m_body"], "a live probe degrades the same way");
});
