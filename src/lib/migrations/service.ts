import { isExternalDatabase } from "@/db/external";
import type { DatabaseDialect } from "@/db/dialect";
import sqliteBundle from "./bundle.json";
import mysqlBundle from "./bundle-mysql.json";
import postgresBundle from "./bundle-postgres.json";
import type { BundledMigration, MigrationNameRow, MigrationResult, MigrationStatus } from "./types";

const BUNDLES: Record<DatabaseDialect, BundledMigration[]> = {
	sqlite: sqliteBundle.migrations as BundledMigration[],
	postgres: postgresBundle.migrations as BundledMigration[],
	mysql: mysqlBundle.migrations as BundledMigration[],
};

/** D1 keeps the table name Wrangler uses, so `wrangler d1 migrations apply` and the in-app runner agree. */
const MIGRATION_TABLES: Record<DatabaseDialect, { table: string; create: string; exists: string }> = {
	sqlite: {
		table: "d1_migrations",
		create: "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
		exists: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
	},
	postgres: {
		table: "mailflare_migrations",
		create: "CREATE TABLE IF NOT EXISTS mailflare_migrations (id BIGSERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		exists: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'mailflare_migrations'",
	},
	mysql: {
		table: "mailflare_migrations",
		create: "CREATE TABLE IF NOT EXISTS mailflare_migrations (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		exists: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = database() AND table_name = 'mailflare_migrations'",
	},
};

export function migrationDialect(db: D1Database): DatabaseDialect {
	return isExternalDatabase(db) ? db.config.dialect : "sqlite";
}

async function getAppliedMigrationNames(db: D1Database): Promise<string[]> {
	const { table, exists } = MIGRATION_TABLES[migrationDialect(db)];
	const found = await db.prepare(exists).first<MigrationNameRow>();
	if (!found) return [];

	const result = await db.prepare(`SELECT name FROM ${table}`).all<MigrationNameRow>();
	return result.results.map((row) => row.name);
}

/**
 * Resume the MySQL poll-claim migration after MySQL's implicit DDL commit but before its ledger insert.
 * This deliberately knows only about this migration: normal MySQL migrations retain their existing path.
 */
export async function resumeMysqlExternalAccountPollClaims(db: D1Database, recordMigration = true): Promise<void> {
	const name = "0036_external_account_poll_claims.sql";
	const { results: columns } = await db.prepare(`
		SELECT column_name AS column_name, data_type AS data_type
		FROM information_schema.columns
		WHERE table_schema = database() AND table_name = 'external_accounts'
	`).all<{ column_name: string; data_type: string }>();
	const byName = new Map(columns.map((column) => [column.column_name.toLowerCase(), column.data_type.toLowerCase()]));
	if (!byName.size) throw new Error("Migration 0036 cannot find external_accounts");

	const actions: string[] = [];
	const tokenType = byName.get("poll_claim_token");
	if (!tokenType) actions.push("ADD COLUMN `poll_claim_token` LONGTEXT NULL");
	else if (tokenType !== "longtext") actions.push("MODIFY COLUMN `poll_claim_token` LONGTEXT NULL");
	const untilType = byName.get("poll_claim_until");
	if (!untilType) actions.push("ADD COLUMN `poll_claim_until` BIGINT NULL");
	else if (untilType !== "bigint") actions.push("MODIFY COLUMN `poll_claim_until` BIGINT NULL");

	const { results: indexRows } = await db.prepare(`
		SELECT column_name AS column_name, seq_in_index AS seq_in_index
		FROM information_schema.statistics
		WHERE table_schema = database() AND table_name = 'external_accounts' AND index_name = 'external_accounts_claim_idx'
		ORDER BY seq_in_index
	`).all<{ column_name: string; seq_in_index: number }>();
	const expectedIndex = ["enabled", "protocol", "poll_claim_until", "last_synced_at"];
	const currentIndex = indexRows.map((row) => row.column_name.toLowerCase());
	if (currentIndex.length && (currentIndex.length !== expectedIndex.length || currentIndex.some((column, index) => column !== expectedIndex[index]))) {
		actions.push("DROP INDEX `external_accounts_claim_idx`");
	}
	if (currentIndex.length !== expectedIndex.length || currentIndex.some((column, index) => column !== expectedIndex[index])) {
		actions.push("ADD INDEX `external_accounts_claim_idx` (`enabled`,`protocol`,`poll_claim_until`,`last_synced_at`)");
	}
	if (actions.length) await db.prepare(`ALTER TABLE \`external_accounts\` ${actions.join(", ")}`).run();
	if (recordMigration) {
		// Ignore a duplicate ledger insert if another starter recorded this exact migration concurrently.
		await db.prepare("INSERT IGNORE INTO mailflare_migrations (name) VALUES (?)").bind(name).run();
	}
}

export async function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	const migrations = BUNDLES[migrationDialect(db)];
	const applied = new Set(await getAppliedMigrationNames(db));
	const committed = new Set(migrations.map((migration) => migration.name));
	const pending = migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);
	const unknown = [...applied].filter((name) => !committed.has(name)).sort();

	return { ready: pending.length === 0 && unknown.length === 0, pending, unknown };
}

export async function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	const dialect = migrationDialect(db);
	const migrations = BUNDLES[dialect];
	const { table, create } = MIGRATION_TABLES[dialect];
	const initial = await getMigrationStatus(db);
	if (initial.unknown.length > 0) {
		throw new Error("The database contains migrations that are not part of this Mailflare release.");
	}

	await db.prepare(create).run();
	const applied: string[] = [];
	const mysqlPollClaimMigration = "0036_external_account_poll_claims.sql";
	// A draft of 0036 may have recorded its ledger after creating the columns with an older token type.
	// Verify that already-ledgered state too, so the runtime schema converges without replaying DDL blindly.
	if (dialect === "mysql" && !initial.pending.includes(mysqlPollClaimMigration)) {
		try {
			await resumeMysqlExternalAccountPollClaims(db, false);
		} catch (error) {
			throw new Error(`Migration ${mysqlPollClaimMigration} verification failed: ${error instanceof Error ? error.message : "Database error"}`);
		}
	}

	for (const name of initial.pending) {
		const migration = migrations.find((candidate) => candidate.name === name);
		if (!migration) continue;

		try {
			if (dialect === "mysql" && name === "0036_external_account_poll_claims.sql") {
				await resumeMysqlExternalAccountPollClaims(db);
			} else if (dialect === "mysql") {
				// MySQL commits DDL implicitly, so a transaction cannot make a migration atomic. Record it last,
				// so a failed migration is retried rather than skipped.
				for (const statement of migration.statements) await db.prepare(statement).run();
				await db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name).run();
			} else {
				await db.batch([
					db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name),
					...migration.statements.map((statement) => db.prepare(statement)),
				]);
			}
			applied.push(name);
		} catch (error) {
			if (dialect !== "mysql") {
				const completed = await db.prepare(`SELECT name FROM ${table} WHERE name = ?`).bind(name).first<MigrationNameRow>();
				if (completed) continue;
			}
			throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : "Database error"}`);
		}
	}

	return { ...(await getMigrationStatus(db)), applied };
}
