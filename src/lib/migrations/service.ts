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

type MysqlColumnInfo = {
	column_name: string;
	data_type: string;
	column_type: string;
	is_nullable: string;
	column_default: string | number | null;
	extra: string;
};
type MysqlColumnExpectation = { type: string; nullable: boolean; defaultValue: string | null };

async function getMysqlColumn(db: D1Database, table: string, column: string): Promise<MysqlColumnInfo | undefined> {
	const { results } = await db.prepare(`
		SELECT column_name AS column_name, data_type AS data_type, column_type AS column_type,
			is_nullable AS is_nullable, column_default AS column_default, extra AS extra
		FROM information_schema.columns
		WHERE table_schema = database() AND table_name = ? AND column_name = ?
	`).bind(table, column).all<MysqlColumnInfo>();
	return results[0];
}

function mysqlColumnMatches(actual: MysqlColumnInfo | undefined, expected: MysqlColumnExpectation): boolean {
	if (!actual) return false;
	const type = expected.type.toLowerCase().replace(/\s+/g, " ").trim();
	const columnType = actual.column_type.toLowerCase().replace(/\s+/g, " ").trim();
	const aliases: Record<string, RegExp> = {
		boolean: /^tinyint(?:\(1\))?$/,
		integer: /^int(?:\(\d+\))?$/,
		int: /^int(?:\(\d+\))?$/,
		bigint: /^bigint(?:\(\d+\))?$/,
	};
	const unsigned = /\bunsigned\b/.test(columnType);
	const expectedUnsigned = /\bunsigned\b/.test(type);
	const baseColumnType = columnType.replace(/\s+unsigned$/, "");
	const typeMatches = aliases[type] ? aliases[type].test(baseColumnType) : baseColumnType === type;
	const nullable = actual.is_nullable.toUpperCase() === "YES";
	const actualDefault = actual.column_default === null ? null : String(actual.column_default).replace(/^['\"]|['\"]$/g, "");
	const expectedDefault = expected.defaultValue ?? null;
	const expectedBoolean = type === "boolean";
	const defaultMatches = actualDefault === expectedDefault
		|| (expectedBoolean && expectedDefault === "true" && actualDefault === "1")
		|| (expectedBoolean && expectedDefault === "false" && actualDefault === "0");
	return typeMatches && unsigned === expectedUnsigned && nullable === expected.nullable
		&& defaultMatches && !/auto_increment|generated/i.test(actual.extra);
}

type MysqlIndexInfo = {
	Column_name?: string;
	Seq_in_index?: number;
	Non_unique?: number;
	Sub_part?: number | null;
	Index_type?: string;
	Collation?: string | null;
	Visible?: string;
	Ignored?: string;
};

function mysqlClaimIndexMatches(rows: MysqlIndexInfo[], expectedColumns: string[]): boolean {
	if (rows.length !== expectedColumns.length) return false;
	return rows.every((row, index) => {
		const ignored = row.Ignored?.toUpperCase();
		const visible = row.Visible?.toUpperCase() ?? (ignored === undefined ? "YES" : ignored === "NO" ? "YES" : "NO");
		return row.Column_name?.toLowerCase() === expectedColumns[index]
			&& Number(row.Seq_in_index) === index + 1
			&& Number(row.Non_unique) === 1
			&& row.Sub_part === null
			&& row.Index_type?.toUpperCase() === "BTREE"
			&& row.Collation?.toUpperCase() === "A"
			&& visible === "YES";
	});
}

async function recordMysqlMigration(db: D1Database, name: string): Promise<void> {
	// INSERT IGNORE handles duplicate ledger writes after concurrent starters independently verify the schema.
	await db.prepare("INSERT IGNORE INTO mailflare_migrations (name) VALUES (?)").bind(name).run();
}

/**
 * Verify/repair the poll-claim shape around MySQL's implicit DDL commit boundary. Rechecking after an ALTER
 * error is the concurrency strategy: a competing initializer may have completed the atomic ALTER first; it is
 * accepted only if a fresh metadata read proves the entire expected shape. No pooled-connection advisory lock
 * is used because the migration executor may route each statement to a different MySQL connection.
 */
export async function resumeMysqlExternalAccountPollClaims(db: D1Database, recordMigration = true): Promise<void> {
	const name = "0036_external_account_poll_claims.sql";
	const reconcile = async () => {
		const token = await getMysqlColumn(db, "external_accounts", "poll_claim_token");
		const until = await getMysqlColumn(db, "external_accounts", "poll_claim_until");
		if (!token && !until) {
			const { results } = await db.prepare("SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema = database() AND table_name = 'external_accounts' LIMIT 1").all<{ column_name: string }>();
			if (!results.length) throw new Error("Migration 0036 cannot find external_accounts");
		}
		const expectedToken = { type: "longtext", nullable: true, defaultValue: null };
		const expectedUntil = { type: "bigint", nullable: true, defaultValue: null };
		const actions: string[] = [];
		if (!token) actions.push("ADD COLUMN `poll_claim_token` LONGTEXT NULL");
		else if (token.data_type.toLowerCase() === "text" && token.is_nullable.toUpperCase() === "YES" && token.column_default === null && token.extra === "") {
			actions.push("MODIFY COLUMN `poll_claim_token` LONGTEXT NULL");
		} else if (!mysqlColumnMatches(token, expectedToken)) {
			throw new Error("Migration 0036 found an incompatible poll_claim_token shape");
		}
		if (!until) actions.push("ADD COLUMN `poll_claim_until` BIGINT NULL");
		else if (!mysqlColumnMatches(until, expectedUntil)) throw new Error("Migration 0036 found an incompatible poll_claim_until shape");

		const { results: indexRows } = await db.prepare("SHOW INDEX FROM `external_accounts` WHERE Key_name = 'external_accounts_claim_idx'").all<MysqlIndexInfo>();
		const expectedIndex = ["enabled", "protocol", "poll_claim_until", "last_synced_at"];
		const indexMatches = mysqlClaimIndexMatches(indexRows, expectedIndex);
		if (indexRows.length && !indexMatches) throw new Error("Migration 0036 found an incompatible external_accounts_claim_idx shape");
		if (!indexMatches) actions.push("ADD INDEX `external_accounts_claim_idx` (`enabled`,`protocol`,`poll_claim_until`,`last_synced_at`)");
		if (actions.length) await db.prepare(`ALTER TABLE \`external_accounts\` ${actions.join(", ")}`).run();
	};

	try {
		await reconcile();
	} catch (error) {
		try { await reconcile(); }
		catch { throw error; }
	}
	if (recordMigration) await recordMysqlMigration(db, name);
}

/** MySQL commits DDL before its ledger write; recover only this exact, reviewed 0037 marker shape. */
async function resumeMysqlIntakeCompletion(db: D1Database, recordMigration = true): Promise<void> {
	const name = "0037_external_message_intake_completion.sql";
	const expected = { type: "boolean", nullable: false, defaultValue: "1" };
	const reconcile = async () => {
		let marker = await getMysqlColumn(db, "messages", "intake_complete");
		if (!marker) {
			const { results } = await db.prepare("SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema = database() AND table_name = 'messages' LIMIT 1").all<{ column_name: string }>();
			if (!results.length) throw new Error("Migration 0037 cannot find messages");
			await db.prepare("ALTER TABLE `messages` ADD `intake_complete` boolean DEFAULT true NOT NULL").run();
			marker = await getMysqlColumn(db, "messages", "intake_complete");
		}
		if (!mysqlColumnMatches(marker, expected)) throw new Error("Migration 0037 found an incompatible messages.intake_complete shape");
	};
	try {
		await reconcile();
	} catch (error) {
		try { await reconcile(); }
		catch { throw error; }
	}
	if (recordMigration) await recordMysqlMigration(db, name);
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
	const mysqlIntakeMigration = "0037_external_message_intake_completion.sql";
	// Verify already-ledgered feature migrations too, so prior drafts converge only from known exact shapes.
	if (dialect === "mysql" && !initial.pending.includes(mysqlPollClaimMigration)) {
		try {
			await resumeMysqlExternalAccountPollClaims(db, false);
		} catch (error) {
			throw new Error(`Migration ${mysqlPollClaimMigration} verification failed: ${error instanceof Error ? error.message : "Database error"}`);
		}
	}
	if (dialect === "mysql" && !initial.pending.includes(mysqlIntakeMigration)) {
		try {
			await resumeMysqlIntakeCompletion(db, false);
		} catch (error) {
			throw new Error(`Migration ${mysqlIntakeMigration} verification failed: ${error instanceof Error ? error.message : "Database error"}`);
		}
	}

	for (const name of initial.pending) {
		const migration = migrations.find((candidate) => candidate.name === name);
		if (!migration) continue;

		try {
			if (dialect === "mysql" && name === mysqlPollClaimMigration) {
				await resumeMysqlExternalAccountPollClaims(db);
			} else if (dialect === "mysql" && name === mysqlIntakeMigration) {
				await resumeMysqlIntakeCompletion(db);
			} else if (dialect === "mysql") {
				// MySQL commits DDL implicitly, so a transaction cannot make a migration atomic. Record it last.
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
