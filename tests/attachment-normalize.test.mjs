import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-attachment-normalize-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: 'export { normalizeSearchText, ATTACHMENT_SEARCH_MIN_TOKEN_CHARS, ATTACHMENT_SEARCH_MAX_TOKEN_CHARS } from "./src/lib/search/normalize.ts";',
		resolveDir: root,
		sourcefile: "attachment-normalize-entry.ts",
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
const { normalizeSearchText } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

test("the stream is lowercase, accent-folded and punctuation-free", () => {
	assert.equal(normalizeSearchText("Müller ünïcödé naïve café résumé"), "muller unicode naive cafe resume");
	assert.equal(normalizeSearchText("un été à Marseille"), "ete marseille", "ét folded, 'un' and 'à' dropped");
	assert.equal(normalizeSearchText("The QUICK brown Fox jumps"), "quick brown fox jumps", "case folds, 'the' drops");
	assert.equal(normalizeSearchText("e-mail me@example.com tomorrow"), "mail example tomorrow", "punctuation splits; 'e', 'me' (too short) and 'com' (stopword) drop");
	assert.equal(normalizeSearchText("onboarding-guide.pdf contents"), "onboarding guide pdf contents");
});

test("tokens a stock InnoDB index cannot keep are dropped from the stream", () => {
	assert.equal(normalizeSearchText("a x i of in on at by we do it"), "", "single and two-letter words go nowhere");
	assert.equal(normalizeSearchText("the of from with that will"), "", "stock stopwords go nowhere");
	assert.equal(normalizeSearchText("ab cd e fg hi"), "", "the corpus' short tokens all drop");
	assert.equal(normalizeSearchText("invoice the confidential"), "invoice confidential", "only the droppable words vanish");
	assert.equal(normalizeSearchText("a".repeat(90) + " invoice"), "invoice", "an over-long token drops too");
});

test("the output is exactly the token space every index sees", () => {
	const normalized = normalizeSearchText("Résumé! of THE me@example.com 2025-11 x");
	assert.equal(normalized, "resume example 2025", "resume folds; me/com/11/x all drop as unindexable");
	assert.doesNotMatch(normalized, /[^\p{L}\p{N} ]/u, "nothing but letters, digits and spaces remains");
	assert.doesNotMatch(normalized, / \S{1,2} |^\S{1,2} | \S{1,2}$|^\S{1,2}$/u, "no sub-three-character token survives");
});

test("edge inputs normalize to an empty stream", () => {
	assert.equal(normalizeSearchText(null), "");
	assert.equal(normalizeSearchText(undefined), "");
	assert.equal(normalizeSearchText(""), "");
	assert.equal(normalizeSearchText("!!!"), "");
	assert.equal(normalizeSearchText("   "), "");
});
