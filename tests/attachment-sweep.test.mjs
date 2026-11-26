import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-attachment-sweep-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Inside the repository so the bundled module resolves `unpdf` from node_modules.
await build({
	stdin: {
		contents: `
			export { ATTACHMENT_EXTRACTION_SWEEP_BATCH, sweepAttachmentExtraction } from "./src/lib/email/attachment-sweep.ts";
		`,
		resolveDir: root,
		sourcefile: "attachment-sweep-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "unpdf"],
	logLevel: "silent",
});
await build({
	entryPoints: {
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: directory,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(directory, `${name}.mjs`)).href);
const { ATTACHMENT_EXTRACTION_SWEEP_BATCH, sweepAttachmentExtraction } = await load("entry");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const encoder = new TextEncoder();

/** A minimal but valid one-page PDF with one text line, as the extractor reads it. */
function pdf(text) {
	const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return encoder.encode(out);
}

/** A BUCKET stub over an in-memory object store, counting the reads it serves. */
function bucket(objects) {
	let gets = 0;
	return {
		gets: () => gets,
		put: async () => {},
		head: async (key) => (key in objects ? { size: objects[key].byteLength } : null),
		get: async (key, options) => {
			gets += 1;
			const bytes = objects[key];
			if (!bytes) return null;
			const slice = options?.range?.length ? bytes.subarray(0, options.range.length) : bytes;
			return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
		},
	};
}

/**
 * A migrated database with one message, and one attachment per entry of
 * `attachments`. Each entry is `{ id, text?, type?, size?, createdAt?, status?,
 * trashed? }`; `text` is both the stored object's body and, for a text file, what
 * extraction should find.
 */
async function fixture(t, attachments) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u', 'o@one.test', 'h', 'O', 'admin', 1, 1);
		INSERT INTO messages (id, user_id, direction, from_addr, to_addr, status, created_at) VALUES ('m1', 'u', 'inbound', 'a@x.test', 'o@one.test', 'received', 1);
	`);
	const objects = {};
	const insert = database.db.prepare(
		"INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, extract_status, trashed_at, created_at) VALUES (?, 'm1', ?, ?, ?, ?, ?, ?, ?)",
	);
	for (const attachment of attachments) {
		const type = attachment.type ?? "text/plain";
		const bytes = attachment.bytes ?? (type === "application/pdf" ? pdf(attachment.text ?? "pdf body") : encoder.encode(attachment.text ?? ""));
		const key = `attachments/m1/${attachment.id}/file`;
		objects[key] = bytes;
		insert.run(attachment.id, `${attachment.id}.dat`, type, attachment.size ?? bytes.byteLength, key, attachment.status ?? "none", attachment.trashed ? 100 : null, attachment.createdAt ?? 1);
	}
	const env = { DB: database, BUCKET: bucket(objects) };
	const row = (id) =>
		database.db.prepare("SELECT extract_status AS status, extracted_text AS text, extracted_at AS at FROM message_attachments WHERE id = ?").get(id);
	const statuses = () => Object.fromEntries(attachments.map((attachment) => [attachment.id, row(attachment.id).status]));
	return { database, env, row, statuses };
}

const pending = (count) => Array.from({ length: count }, (_, index) => ({ id: `a${index + 1}`, text: `text ${index + 1}`, createdAt: 1000 + index }));

test("one run drains a bounded batch of the oldest pending rows", async (t) => {
	const { env, row, statuses } = await fixture(t, pending(12));
	assert.equal(ATTACHMENT_EXTRACTION_SWEEP_BATCH, 5);

	const first = await sweepAttachmentExtraction(env);
	assert.deepEqual(first, { scanned: 5, done: 5, failed: 0, skipped: 0, pending: 7 });
	assert.deepEqual(Object.keys(statuses()).filter((id) => statuses()[id] === "done"), ["a1", "a2", "a3", "a4", "a5"], "oldest first");
	assert.equal(row("a1").text, "text 1", "the extracted text is stored");
	assert.ok(row("a1").at, "the run records when it ran");

	assert.deepEqual(await sweepAttachmentExtraction(env), { scanned: 5, done: 5, failed: 0, skipped: 0, pending: 2 });
	assert.deepEqual(await sweepAttachmentExtraction(env), { scanned: 2, done: 2, failed: 0, skipped: 0, pending: 0 });
	// A drained queue costs nothing: the batch read finds no candidates.
	assert.deepEqual(await sweepAttachmentExtraction(env), { scanned: 0, done: 0, failed: 0, skipped: 0, pending: 0 });
});

test("a run takes the limit it is given", async (t) => {
	const { env, statuses } = await fixture(t, pending(4));
	assert.deepEqual(await sweepAttachmentExtraction(env, { limit: 1 }), { scanned: 1, done: 1, failed: 0, skipped: 0, pending: 3 });
	assert.equal(statuses().a1, "done");
	assert.equal(statuses().a2, "none", "the rest wait for the next run");
});

test("a PDF is parsed by the sweep, which is the only enricher", async (t) => {
	const { env, row } = await fixture(t, [{ id: "p1", type: "application/pdf", text: "quarterly revenue" }]);
	assert.equal(row("p1").status, "none", "nothing extracted it on the way in");
	const result = await sweepAttachmentExtraction(env);
	assert.deepEqual(result, { scanned: 1, done: 1, failed: 0, skipped: 0, pending: 0 });
	assert.equal(row("p1").status, "done");
	assert.match(row("p1").text, /quarterly revenue/);
});

test("a failing row keeps its own status and the batch continues", async (t) => {
	const { env, statuses } = await fixture(t, pending(4));
	// The object for a2 is gone: the extractor records "failed" instead of throwing.
	env.BUCKET.get = ((get) => async (key, options) => (key.includes("/a2/") ? null : get(key, options)))(env.BUCKET.get);
	const result = await sweepAttachmentExtraction(env);
	assert.deepEqual(result, { scanned: 4, done: 3, failed: 1, skipped: 0, pending: 0 });
	assert.deepEqual(statuses(), { a1: "done", a2: "failed", a3: "done", a4: "done" });
});

test("an unsupported attachment is decided skipped without reading its object", async (t) => {
	const { env, row } = await fixture(t, [
		{ id: "z1", type: "application/zip", text: "PK", createdAt: 1 },
		{ id: "z2", text: "after the skip", createdAt: 2 },
	]);
	const result = await sweepAttachmentExtraction(env);
	assert.deepEqual(result, { scanned: 2, done: 1, failed: 0, skipped: 1, pending: 0 });
	assert.equal(row("z1").status, "skipped");
	assert.equal(row("z2").status, "done", "one decided row does not end the batch");
});

test("a decided row is not swept again", async (t) => {
	const { env, database } = await fixture(t, [{ id: "a1", text: "already read", status: "done" }]);
	database.db.prepare("UPDATE message_attachments SET extracted_text = 'stored text' WHERE id = 'a1'").run();
	const result = await sweepAttachmentExtraction(env);
	assert.deepEqual(result, { scanned: 0, done: 0, failed: 0, skipped: 0, pending: 0 });
	assert.equal(env.BUCKET.gets(), 0, "nothing was read");
});

test("a trashed attachment is extracted like any other", async (t) => {
	const { env, row } = await fixture(t, [{ id: "a1", text: "moved to the trash", trashed: true }]);
	assert.equal((await sweepAttachmentExtraction(env)).done, 1);
	assert.equal(row("a1").status, "done", "a restore already has its text");
});
