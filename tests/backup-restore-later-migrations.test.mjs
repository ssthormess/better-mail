import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "node_modules", ".cache", "backup-restore-later-migrations");
const outfile = join(outDir, "backup.mjs");
await build({
	stdin: {
		contents: 'export * from "./src/lib/backups/export";',
		resolveDir: root,
		loader: "ts",
	},
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(outfile).href);
const { migrations } = JSON.parse(readFileSync(join(root, "src/lib/migrations/bundle.json"), "utf8"));

function d1(sqlite) {
	const prepare = (sql) => {
		const statement = {
			values: [],
			bind(...values) {
				statement.values = values;
				return statement;
			},
			async all() {
				return { results: sqlite.prepare(sql).all(...statement.values), success: true, meta: {} };
			},
			async run() {
				const result = sqlite.prepare(sql).run(...statement.values);
				return { results: [], success: true, meta: { changes: result.changes } };
			},
			async first() {
				return sqlite.prepare(sql).get(...statement.values) ?? null;
			},
		};
		return statement;
	};
	return {
		prepare,
		async batch(statements) {
			return Promise.all(statements.map((statement) => statement.run()));
		},
	};
}

/**
 * A migrated database; with `laterTables` false the migrations that introduced
 * LATER_MIGRATION_TABLES members like mailing_lists are skipped, standing in for
 * an installation whose database lags its code.
 */
function database({ laterTables = true } = {}) {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	for (const migration of migrations) {
		if (!laterTables && migration.name.includes("mailing_lists")) continue;
		for (const statement of migration.statements) sqlite.exec(statement);
	}
	return sqlite;
}

function addUser(sqlite) {
	sqlite.prepare(
		`INSERT INTO users (
			id, email, password_hash, name, role, is_primary_admin, disabled, can_manage_mailboxes,
			can_manage_domains, can_manage_users, keyboard_shortcuts_enabled, spam_protection_enabled,
			show_full_recipient_addresses, remote_content_mode, require_second_factor, totp_enabled, created_at
		) VALUES ('u1', 'u1@example.test', '!passkey-only', 'User', 'user', 0, 0, 0, 0, 0, 1, 1, 0, 'allow', 0, 0, 1)`,
	).run();
}

const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test("an export on a database without the mailing list tables succeeds and ships them empty", async () => {
	const sqlite = database({ laterTables: false });
	addUser(sqlite);
	const backup = await exportDatabaseRecords(d1(sqlite));
	const document = JSON.parse(new TextDecoder().decode(backup));
	assert.deepEqual(document.tables.mailing_lists, []);
	assert.deepEqual(document.tables.mailing_list_members, []);
});

test("a backup document without the mailing list tables restores onto a migrated database", async () => {
	const source = database();
	addUser(source);
	const backup = await exportDatabaseRecords(d1(source));
	const document = JSON.parse(new TextDecoder().decode(backup));
	delete document.tables.mailing_lists;
	delete document.tables.mailing_list_members;
	document.includedTables = document.includedTables.filter((table) => !table.startsWith("mailing_list"));
	const old = new TextEncoder().encode(JSON.stringify(document));

	const target = database();
	await restoreDatabaseRecords(d1(target), buffer(old));
	assert.equal(target.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
	assert.equal(target.prepare("SELECT COUNT(*) AS count FROM mailing_lists").get().count, 0);
	assert.equal(target.prepare("SELECT COUNT(*) AS count FROM mailing_list_members").get().count, 0);
});

test("a document carrying list rows is rejected before any row is deleted on an unmigrated database", async () => {
	const source = database();
	addUser(source);
	source.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.test', 'z', 'active', 1);
		INSERT INTO mailing_lists (id, user_id, domain_id, local_part, name, disabled, created_at) VALUES ('l1', 'u1', 'd1', 'team', 'Team', 0, 1);
		INSERT INTO mailing_list_members (id, list_id, email, role, created_at) VALUES ('m1', 'l1', 'a@example.net', 'member', 1);`);
	const backup = await exportDatabaseRecords(d1(source));

	const target = database({ laterTables: false });
	addUser(target);
	await assert.rejects(
		restoreDatabaseRecords(d1(target), buffer(backup)),
		/Apply pending database migrations before restoring mailing_lists, mailing_list_members/,
	);
	// The rejection lands before the restore's teardown: the canary user is
	// untouched, not even marked deleted.
	const row = target.prepare("SELECT deleted_at FROM users WHERE id = 'u1'").get();
	assert.equal(row.deleted_at, null);
});
