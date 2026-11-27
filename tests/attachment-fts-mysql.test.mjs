import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-attachment-fts-mysql-"));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.MAILFLARE_DB_DIALECT = "mysql";
await build({
	stdin: {
		contents: `
			export { and } from "drizzle-orm";
			export { openExternalDatabase } from "./src/db/external.ts";
			export { resolveDatabaseConfig } from "./src/db/dialect.ts";
			export { buildSearchConditions } from "./src/lib/search/conditions.ts";
			export { buildBooleanFreeTextMatch, buildBooleanNegation, parseSearchQuery } from "./src/lib/search/query-utils.ts";
			export { hasAttachmentSearchIndex, clearAttachmentIndexProbe } from "./src/lib/search/attachment-index.ts";
			export { getDb, schema } from "./src/db/index.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-fts-mysql-entry.ts",
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
const { and, openExternalDatabase, resolveDatabaseConfig, buildSearchConditions, buildBooleanFreeTextMatch, buildBooleanNegation, parseSearchQuery, hasAttachmentSearchIndex, clearAttachmentIndexProbe, getDb, schema } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/**
 * No MySQL server here: the executor is a stub that records the statements it is asked
 * to run, so the assertions are on the SQL the dialect path produces. db-smoke and the
 * container round prove the same statements on a real MySQL.
 */
const DB = openExternalDatabase(resolveDatabaseConfig({ DATABASE_URL: "mysql://u:p@h/db" }), true);
const queries = [];
DB.sqlExecutor.query = async (text, params) => {
	queries.push({ text, params });
	return { rows: [], affectedRows: 0 };
};
const db = getDb({ DB });

const compiled = (query, options = { attachmentText: true }) =>
	db.select({ id: schema.messages.id }).from(schema.messages).where(and(...buildSearchConditions(query, "UTC", options))).toSQL();

test("the positive half is a boolean-mode AGAINST over the eligible set", async () => {
	const { sql, params } = compiled("smoketok report");
	assert.match(sql, /match\(`message_attachments`\.`extracted_text`\) against\(\? in boolean mode\)/i, "the FULLTEXT index is queried in boolean mode");
	assert.match(sql, /extract_status` = 'done'/, "the eligible set keeps the done predicate");
	assert.match(sql, /extracted_text` is not null/i, "the eligible set keeps the nonnull predicate");
	assert.ok(!sql.includes("smoketok"), "no term text is interpolated into the SQL");
	assert.ok(params.includes("+smoketok* +report*"), "both terms are required in one bound AGAINST expression");
	assert.equal(buildBooleanFreeTextMatch(parseSearchQuery('smoketok "exact phrase"', "UTC")), '+smoketok* +"exact phrase"');
});

test("a negated term is rejected by a NOT IN against the same index", async () => {
	const { sql, params } = compiled("quarterly -confidential -\"two words\"");
	assert.match(sql, /not `messages`\.id in \(select .*match\(.*against\(\? in boolean mode\)/is, "the negation is its own NOT IN subquery");
	assert.ok(params.includes("confidential* \"two words\""), "negated terms are ORed inside one bound expression");
	assert.equal(buildBooleanNegation(parseSearchQuery("a -confidential", "UTC")), "confidential*");
});

test("without the index the conditions stay the plain LIKE scan", async () => {
	const { sql } = compiled("smoketok -confidential", { attachmentText: false });
	assert.ok(!/against\(/i.test(sql), "no AGAINST clause is emitted without the index");
	assert.ok(/like/i.test(sql), "the LIKE scan is unchanged");
});

test("the probe answers from information_schema and caches per connection", async () => {
	let calls = 0;
	DB.sqlExecutor.query = async (text) => {
		calls += 1;
		assert.match(text, /information_schema\.statistics/i, "the probe reads the index catalog");
		assert.match(text, /message_attachments_extracted_text_fts_idx/, "the probe names the FULLTEXT index");
		return { rows: [{ n: 1 }], affectedRows: 0 };
	};
	assert.equal(await hasAttachmentSearchIndex({ DB }), true);
	assert.equal(await hasAttachmentSearchIndex({ DB }), true);
	assert.equal(calls, 1, "the answer is cached on the connection");
	clearAttachmentIndexProbe(DB);
	DB.sqlExecutor.query = async () => ({ rows: [{ n: 0 }], affectedRows: 0 });
	assert.equal(await hasAttachmentSearchIndex({ DB }), false, "a zero count degrades to message-only search");
});
