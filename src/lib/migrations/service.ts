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

async function getMysqlColumnNames(db: D1Database, table: string): Promise<string[]> {
	const { results } = await db.prepare(`SELECT column_name AS column_name FROM information_schema.columns
		WHERE table_schema = database() AND table_name = ?`).bind(table).all<{ column_name: string }>();
	return results.map((row) => row.column_name.toLowerCase()).sort();
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

async function requireMysqlTable(db: D1Database, table: string, migration: string): Promise<void> {
	const { results } = await db.prepare("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = database() AND table_name = ?")
		.bind(table).all<{ table_name: string }>();
	if (!results.length) throw new Error(`Migration ${migration} cannot find ${table}`);
}

/** Recover only the exact nullable LONGTEXT cursor column added by 0038. */
async function resumeMysqlRawMailSweepCursor(db: D1Database, recordMigration = true): Promise<void> {
	const name = "0038_raw_mail_sweep_cursor.sql";
	await requireMysqlTable(db, "app_settings", "0038");
	const reconcile = async () => {
		let column = await getMysqlColumn(db, "app_settings", "raw_mail_sweep_cursor");
		if (!column) {
			await db.prepare("ALTER TABLE `app_settings` ADD `raw_mail_sweep_cursor` longtext").run();
			column = await getMysqlColumn(db, "app_settings", "raw_mail_sweep_cursor");
		}
		if (!mysqlColumnMatches(column, { type: "longtext", nullable: true, defaultValue: null })) {
			throw new Error("Migration 0038 found an incompatible app_settings.raw_mail_sweep_cursor shape");
		}
	};
	try { await reconcile(); }
	catch (error) {
		try { await reconcile(); }
		catch { throw error; }
	}
	if (recordMigration) await recordMysqlMigration(db, name);
}

const MYSQL_RAW_SWEEP_PENDING_TABLE = `CREATE TABLE \`raw_sweep_pending_deletes\` (
\t\`raw_r2_key\` varchar(512) NOT NULL,
\t\`claim_token\` longtext NOT NULL,
\t\`claimed_at\` bigint NOT NULL,
\tCONSTRAINT \`raw_sweep_pending_deletes_raw_r2_key\` PRIMARY KEY(\`raw_r2_key\`)
)`;
const MYSQL_RAW_SWEEP_TRIGGERS = [
	{
		name: "raw_sweep_pending_bi", table: "raw_sweep_pending_deletes", event: "INSERT",
		body: "BEGIN UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default'; IF EXISTS (SELECT 1 FROM `messages` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'raw_sweep_referenced'; END IF; END",
	},
	{
		name: "raw_sweep_messages_bi", table: "messages", event: "INSERT",
		body: "BEGIN IF NEW.`raw_r2_key` LIKE 'inbound/%' THEN UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default'; IF EXISTS (SELECT 1 FROM `raw_sweep_pending_deletes` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'raw_sweep_in_progress'; END IF; END IF; END",
	},
	{
		name: "raw_sweep_messages_bu", table: "messages", event: "UPDATE",
		body: "BEGIN IF NOT (NEW.`raw_r2_key` <=> OLD.`raw_r2_key`) AND NEW.`raw_r2_key` LIKE 'inbound/%' THEN UPDATE `app_settings` SET `raw_mail_sweep_fence` = `raw_mail_sweep_fence` + 1 WHERE `id` = 'default'; IF EXISTS (SELECT 1 FROM `raw_sweep_pending_deletes` WHERE `raw_r2_key` = NEW.`raw_r2_key`) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'raw_sweep_in_progress'; END IF; END IF; END",
	},
];

function normalizeMysqlTriggerBody(value: string): string {
	return value.toLowerCase().replaceAll("`", "").replace(/\s+/g, " ").replace(/\s*([(),;=<>])\s*/g, "$1").trim();
}

async function mysqlRawSweepTrigger(db: D1Database, name: string) {
	const { results } = await db.prepare(`SELECT trigger_name AS trigger_name, event_manipulation AS event_manipulation,
		event_object_table AS event_object_table, action_timing AS action_timing, action_statement AS action_statement
		FROM information_schema.triggers WHERE trigger_schema = database() AND trigger_name = ?`).bind(name).all<{
		trigger_name: string; event_manipulation: string; event_object_table: string; action_timing: string; action_statement: string;
	}>();
	return results[0];
}

function mysqlRawSweepIndexMatches(rows: MysqlIndexInfo[]): boolean {
	return rows.length === 1 && rows[0].Column_name?.toLowerCase() === "raw_r2_key"
		&& Number(rows[0].Seq_in_index) === 1 && Number(rows[0].Non_unique) === 0
		&& rows[0].Sub_part === null && rows[0].Index_type?.toUpperCase() === "BTREE";
}

/** Reconcile only the reviewed 0039 fence column, pending-key table, and three trigger bodies. */
async function resumeMysqlRawSweepFence(db: D1Database, recordMigration = true): Promise<void> {
	const name = "0039_raw_sweep_fence.sql";
	await requireMysqlTable(db, "app_settings", "0039");
	const reconcile = async () => {
		let fence = await getMysqlColumn(db, "app_settings", "raw_mail_sweep_fence");
		if (!fence) {
			await db.prepare("ALTER TABLE `app_settings` ADD `raw_mail_sweep_fence` bigint DEFAULT 0 NOT NULL").run();
			fence = await getMysqlColumn(db, "app_settings", "raw_mail_sweep_fence");
		}
		if (!mysqlColumnMatches(fence, { type: "bigint", nullable: false, defaultValue: "0" })) {
			throw new Error("Migration 0039 found an incompatible app_settings.raw_mail_sweep_fence shape");
		}

		const table = await db.prepare("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = database() AND table_name = 'raw_sweep_pending_deletes'").first<{ table_name: string }>();
		if (!table) await db.prepare(MYSQL_RAW_SWEEP_PENDING_TABLE).run();
		const pendingColumns = await getMysqlColumnNames(db, "raw_sweep_pending_deletes");
		const baseColumns = ["claim_token", "claimed_at", "raw_r2_key"];
		const completedColumns = [...baseColumns, "delete_complete"].sort();
		if (JSON.stringify(pendingColumns) !== JSON.stringify(baseColumns) && JSON.stringify(pendingColumns) !== JSON.stringify(completedColumns)) {
			throw new Error("Migration 0039 found an incompatible raw_sweep_pending_deletes column set");
		}
		if (pendingColumns.includes("delete_complete") && !mysqlColumnMatches(
			await getMysqlColumn(db, "raw_sweep_pending_deletes", "delete_complete"),
			{ type: "boolean", nullable: false, defaultValue: "0" },
		)) throw new Error("Migration 0039 found an incompatible raw_sweep_pending_deletes.delete_complete shape");
		for (const [column, expected] of [
			["raw_r2_key", { type: "varchar(512)", nullable: false, defaultValue: null }],
			["claim_token", { type: "longtext", nullable: false, defaultValue: null }],
			["claimed_at", { type: "bigint", nullable: false, defaultValue: null }],
		] as const) {
			if (!mysqlColumnMatches(await getMysqlColumn(db, "raw_sweep_pending_deletes", column), expected)) {
				throw new Error(`Migration 0039 found an incompatible raw_sweep_pending_deletes.${column} shape`);
			}
		}
		const { results: indexes } = await db.prepare("SHOW INDEX FROM `raw_sweep_pending_deletes`").all<MysqlIndexInfo>();
		if (!mysqlRawSweepIndexMatches(indexes)) throw new Error("Migration 0039 found an incompatible raw_sweep_pending_deletes primary key");

		for (const expected of MYSQL_RAW_SWEEP_TRIGGERS) {
			let actual = await mysqlRawSweepTrigger(db, expected.name);
			if (!actual) {
				await db.prepare(`CREATE TRIGGER \`${expected.name}\` BEFORE ${expected.event} ON \`${expected.table}\` FOR EACH ROW ${expected.body}`).run();
				actual = await mysqlRawSweepTrigger(db, expected.name);
			}
			if (!actual || actual.event_manipulation.toUpperCase() !== expected.event || actual.event_object_table !== expected.table
				|| actual.action_timing.toUpperCase() !== "BEFORE"
				|| normalizeMysqlTriggerBody(actual.action_statement) !== normalizeMysqlTriggerBody(expected.body)) {
				throw new Error(`Migration 0039 found an incompatible ${expected.name} trigger`);
			}
		}
	};
	try { await reconcile(); }
	catch (error) {
		try { await reconcile(); }
		catch { throw error; }
	}
	if (recordMigration) await recordMysqlMigration(db, name);
}

async function resumeMysqlRawSweepDeleteComplete(db: D1Database, recordMigration = true): Promise<void> {
	const name = "0040_raw_sweep_delete_complete.sql";
	await requireMysqlTable(db, "raw_sweep_pending_deletes", "0040");
	const reconcile = async () => {
		let column = await getMysqlColumn(db, "raw_sweep_pending_deletes", "delete_complete");
		if (!column) {
			await db.prepare("ALTER TABLE `raw_sweep_pending_deletes` ADD `delete_complete` boolean DEFAULT false NOT NULL").run();
			column = await getMysqlColumn(db, "raw_sweep_pending_deletes", "delete_complete");
		}
		if (!mysqlColumnMatches(column, { type: "boolean", nullable: false, defaultValue: "0" })
			|| JSON.stringify(await getMysqlColumnNames(db, "raw_sweep_pending_deletes")) !== JSON.stringify(["claim_token", "claimed_at", "delete_complete", "raw_r2_key"])) {
			throw new Error("Migration 0040 found an incompatible raw_sweep_pending_deletes.delete_complete shape");
		}
	};
	try { await reconcile(); }
	catch (error) {
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
	const mysqlSweepCursorMigration = "0038_raw_mail_sweep_cursor.sql";
	const mysqlSweepFenceMigration = "0039_raw_sweep_fence.sql";
	const mysqlSweepDeleteCompleteMigration = "0040_raw_sweep_delete_complete.sql";
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
	if (dialect === "mysql" && !initial.pending.includes(mysqlSweepCursorMigration)) {
		try { await resumeMysqlRawMailSweepCursor(db, false); }
		catch (error) { throw new Error(`Migration ${mysqlSweepCursorMigration} verification failed: ${error instanceof Error ? error.message : "Database error"}`); }
	}
	if (dialect === "mysql" && !initial.pending.includes(mysqlSweepFenceMigration)) {
		try { await resumeMysqlRawSweepFence(db, false); }
		catch (error) { throw new Error(`Migration ${mysqlSweepFenceMigration} verification failed: ${error instanceof Error ? error.message : "Database error"}`); }
	}
	if (dialect === "mysql" && !initial.pending.includes(mysqlSweepDeleteCompleteMigration)) {
		try { await resumeMysqlRawSweepDeleteComplete(db, false); }
		catch (error) { throw new Error(`Migration ${mysqlSweepDeleteCompleteMigration} verification failed: ${error instanceof Error ? error.message : "Database error"}`); }
	}

	for (const name of initial.pending) {
		const migration = migrations.find((candidate) => candidate.name === name);
		if (!migration) continue;

		try {
			if (dialect === "mysql" && name === mysqlPollClaimMigration) {
				await resumeMysqlExternalAccountPollClaims(db);
			} else if (dialect === "mysql" && name === mysqlIntakeMigration) {
				await resumeMysqlIntakeCompletion(db);
			} else if (dialect === "mysql" && name === mysqlSweepCursorMigration) {
				await resumeMysqlRawMailSweepCursor(db);
			} else if (dialect === "mysql" && name === mysqlSweepFenceMigration) {
				await resumeMysqlRawSweepFence(db);
			} else if (dialect === "mysql" && name === mysqlSweepDeleteCompleteMigration) {
				await resumeMysqlRawSweepDeleteComplete(db);
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
