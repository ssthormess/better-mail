import { eq, sql } from "drizzle-orm";
import { createDb, getDb } from "@/db";
import { isExternalDatabase } from "@/db/external";
import { appSettings, rawSweepPendingDeletes, schema } from "@/db/schema";

const RAW_SWEEP_SETTINGS_ID = "default";
const PENDING_RETRY_MS = 5_000;

type AppDb = ReturnType<typeof getDb>;
type TransactionalBinding = D1Database & {
	supportsTransaction?: () => boolean;
	transaction?: <T>(work: (tx: D1Database) => Promise<T>) => Promise<T>;
};

export async function lockRawSweepFence(db: AppDb): Promise<void> {
	await db.update(appSettings).set({
		rawMailSweepFence: sql`${appSettings.rawMailSweepFence} + 1`,
	}).where(eq(appSettings.id, RAW_SWEEP_SETTINGS_ID));
}

/** Run a callback on a real atomic transaction when this runtime/driver supports one. */
export async function withRawSweepTransaction<T>(env: CloudflareEnv, work: (tx: AppDb) => Promise<T>): Promise<{ supported: true; value: T } | { supported: false }> {
	const binding = env.DB as TransactionalBinding;
	if (isExternalDatabase(binding)) {
		if (!binding.supportsTransaction()) return { supported: false };
		return {
			supported: true,
			value: await binding.transaction((tx) => work(binding.createDrizzle(schema as never, (tx as unknown as { executor(): import("@/db/drivers/types").SqlExecutor }).executor()) as AppDb)),
		};
	}
	if (binding.supportsTransaction?.() && binding.transaction) {
		return {
			supported: true,
			value: await binding.transaction((tx) => work(createDb(tx) as AppDb)),
		};
	}
	return { supported: false };
}

function isSweepInProgress(error: unknown): boolean {
	return error instanceof Error && error.message.includes("raw_sweep_in_progress");
}

async function waitForSweepToFinish(db: AppDb, rawR2Key: string, deadlineAt?: number): Promise<void> {
	const until = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + PENDING_RETRY_MS);
	while (Date.now() < until) {
		const [pending] = await db.select({ key: rawSweepPendingDeletes.rawR2Key }).from(rawSweepPendingDeletes)
			.where(eq(rawSweepPendingDeletes.rawR2Key, rawR2Key)).limit(1);
		if (!pending) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Raw object cleanup is in progress; inbound processing should retry");
}

/**
 * Serialize the final raw-object write and message reference with orphan deletion. D1 has no interactive
 * transaction API, so its insert triggers fence this final write against the persistent pending-delete row.
 */
export async function insertWithRawObjectFence<T>(
	env: CloudflareEnv,
	db: AppDb,
	rawR2Key: string,
	rawBytes: ArrayBuffer,
	deadlineAt: number | undefined,
	awaitOperation: <Value>(operation: Promise<Value>) => Promise<Value>,
	insert: (db: AppDb) => Promise<T>,
): Promise<T> {
	const atomic = await withRawSweepTransaction(env, async (tx) => {
		await lockRawSweepFence(tx);
		if (!await awaitOperation(env.BUCKET.get(rawR2Key))) {
			await awaitOperation(env.BUCKET.put(rawR2Key, rawBytes, { httpMetadata: { contentType: "message/rfc822" } }));
		}
		return insert(tx);
	});
	if (atomic.supported) return atomic.value;

	// Non-transactional external HTTP drivers defer inbound-raw deletion in the sweeper. D1 uses its SQLite
	// triggers as a statement-atomic fence; a blocked insert waits for deletion and then restores these bytes.
	if (isExternalDatabase(env.DB)) {
		await awaitOperation(env.BUCKET.put(rawR2Key, rawBytes, { httpMetadata: { contentType: "message/rfc822" } }));
		return insert(db);
	}

	const retryUntil = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + PENDING_RETRY_MS);
	while (true) {
		if (!await awaitOperation(env.BUCKET.get(rawR2Key))) {
			await awaitOperation(env.BUCKET.put(rawR2Key, rawBytes, { httpMetadata: { contentType: "message/rfc822" } }));
		}
		try {
			return await insert(db);
		} catch (error) {
			if (!isSweepInProgress(error)) throw error;
			await waitForSweepToFinish(db, rawR2Key, retryUntil);
			if (Date.now() >= retryUntil) throw new Error("Raw object cleanup is in progress; inbound processing should retry");
		}
	}
}
