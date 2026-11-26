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
	const actualDefault = actual.column_default === null ? null : String(actual.column_default).replace(/^['\"]|['\"]$/g, "").toLowerCase();
	const expectedDefault = expected.defaultValue?.toLowerCase() ?? null;
	const expectedBoolean = type === "boolean";
	const defaultMatches = actualDefault === expectedDefault
		|| (expectedBoolean && expectedDefault === "true" && actualDefault === "1")
		|| (expectedBoolean && expectedDefault === "false" && actualDefault === "0");
	return typeMatches && unsigned === expectedUnsigned && nullable === expected.nullable
		&& defaultMatches && !/auto_increment|generated/i.test(actual.extra);
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

		const { results: indexRows } = await db.prepare(`
			SELECT column_name AS column_name, seq_in_index AS seq_in_index, non_unique AS non_unique
			FROM information_schema.statistics
			WHERE table_schema = database() AND table_name = 'external_accounts' AND index_name = 'external_accounts_claim_idx'
			ORDER BY seq_in_index
		`).all<{ column_name: string; seq_in_index: number; non_unique: number }>();
		const expectedIndex = ["enabled", "protocol", "poll_claim_until", "last_synced_at"];
		const currentIndex = indexRows.map((row) => row.column_name.toLowerCase());
		const indexMatches = currentIndex.length === expectedIndex.length
			&& currentIndex.every((column, index) => column === expectedIndex[index])
			&& indexRows.every((row) => Number(row.non_unique) === 1);
		if (currentIndex.length && !indexMatches) throw new Error("Migration 0036 found an incompatible external_accounts_claim_idx shape");
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

function parseMysqlColumnAddition(statement: string): { table: string; column: string; expectation: MysqlColumnExpectation } | null {
	const match = statement.match(/^\s*ALTER\s+TABLE\s+([`\w]+)\s+ADD(?:\s+COLUMN)?\s+([`\w]+)\s+([\s\S]+?)\s*;?\s*$/i);
	if (!match) return null;
	const unquote = (value: string) => value.replace(/^`|`$/g, "").toLowerCase();
	const definition = match[3].replace(/;\s*$/, "").trim();
	const typeMatch = definition.match(/^([a-z]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+unsigned)?)/i);
	if (!typeMatch) return null;
	const defaultMatch = definition.match(/\bDEFAULT\s+(true|false|null|-?\d+(?:\.\d+)?|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")/i);
	const defaultValue = defaultMatch ? defaultMatch[1].replace(/^['\"]|['\"]$/g, "").toLowerCase() : null;
	return {
		table: unquote(match[1]),
		column: unquote(match[2]),
		expectation: { type: typeMatch[1].replace(/\s+/g, " ").trim().toLowerCase(), nullable: !/\bNOT\s+NULL\b/i.test(definition), defaultValue },
	};
}

async function applyMysqlAddColumnMigration(db: D1Database, name: string, additions: Array<{ statement: string; table: string; column: string; expectation: MysqlColumnExpectation }>): Promise<void> {
	for (const addition of additions) {
		const existing = await getMysqlColumn(db, addition.table, addition.column);
		if (existing) {
			if (!mysqlColumnMatches(existing, addition.expectation)) throw new Error(`Column ${addition.table}.${addition.column} exists with an incompatible shape`);
			continue;
		}
		try {
			await db.prepare(addition.statement).run();
		} catch (error) {
			const raced = await getMysqlColumn(db, addition.table, addition.column);
			if (!mysqlColumnMatches(raced, addition.expectation)) throw error;
		}
	}
	await recordMysqlMigration(db, name);
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
				const parsedAdditions = migration.statements.map((statement) => ({ statement, parsed: parseMysqlColumnAddition(statement) }));
				if (parsedAdditions.length && parsedAdditions.every((entry) => entry.parsed)) {
					await applyMysqlAddColumnMigration(db, name, parsedAdditions.map((entry) => ({ statement: entry.statement, ...entry.parsed! })));
				} else if (migration.statements.some((statement) => statement.trimStart().toLowerCase().startsWith("alter table") && /\bADD\s+COLUMN\b/i.test(statement))) {
					throw new Error("MySQL additive-column migration is not in the verifiable single-column ALTER form");
				} else {
					// MySQL commits DDL implicitly, so a transaction cannot make a migration atomic. Record it last,
					// so other migration classes retain their existing path.
					for (const statement of migration.statements) await db.prepare(statement).run();
					await db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name).run();
				}
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
