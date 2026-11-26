import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-search-negation-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/search/query-utils.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { buildFtsFreeTextMatch, buildFtsNegation, parseSearchQuery } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

/**
 * The two expressions conditions.ts applies: positive free text as an IN, negations as a
 * separate NOT IN. FTS5 has no unary NOT, so a negation is never part of the positive
 * MATCH — folding it in let another index satisfy the positive half in F52.
 */
function run(query) {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE VIRTUAL TABLE f USING fts5(subject)");
	db.exec("INSERT INTO f(subject) VALUES ('newsletter weekly'), ('invoice due'), ('hello there')");
	const parsed = parseSearchQuery(query, "UTC");
	const positive = buildFtsFreeTextMatch(parsed);
	const negation = buildFtsNegation(parsed);
	const clauses = [];
	const params = [];
	if (positive) {
		clauses.push("rowid IN (SELECT rowid FROM f WHERE f MATCH ?)");
		params.push(positive);
	}
	if (negation) {
		clauses.push("rowid NOT IN (SELECT rowid FROM f WHERE f MATCH ?)");
		params.push(negation);
	}
	const sql = `SELECT subject FROM f${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}`;
	return db.prepare(sql).all(...params).map((row) => row.subject);
}

test("a negation-only search excludes the term and keeps everything else", () => {
	assert.deepEqual(run("-newsletter").sort(), ["hello there", "invoice due"]);
});

test("a negation is applied next to the positive match, not inside it", () => {
	assert.deepEqual(run("-newsletter hello"), ["hello there"]);
	assert.equal(buildFtsFreeTextMatch(parseSearchQuery("invoice -confidential", "UTC")), '"invoice"*', "the positive expression holds no NOT");
	assert.equal(buildFtsNegation(parseSearchQuery("invoice -confidential", "UTC")), '"confidential"*');
});

test("a query with no text terms has nothing to match", () => {
	const parsed = parseSearchQuery("is:unread", "UTC");
	assert.equal(buildFtsFreeTextMatch(parsed), null);
	assert.equal(buildFtsNegation(parsed), null);
});
