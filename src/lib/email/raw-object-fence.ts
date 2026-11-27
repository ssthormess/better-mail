import { and, eq, sql } from "drizzle-orm";
import { createDb, getDb } from "@/db";
import { isExternalDatabase } from "@/db/external";
import { appSettings, rawSweepPendingDeletes, schema } from "@/db/schema";

const RAW_SWEEP_SETTINGS_ID = "default";
const PENDING_RETRY_MS = 5_000;
const PENDING_POLL_MS = 50;
/** A claim this old cannot still have a `BUCKET.delete` in flight; its marker may be released. */
export const STALE_PENDING_DELETE_MS = 60 * 60 * 1000;

type AppDb = ReturnType<typeof getDb>;
type PendingDelete = typeof rawSweepPendingDeletes.$inferSelect;
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

/**
 * Trigger aborts arrive wrapped in `DrizzleQueryError` ("Failed query: …"), whose message never
 * contains the trigger text; the real error hangs off `.cause`. Walk the chain for our marker string.
 */
export function isRawSweepAbort(error: unknown, reason: "raw_sweep_in_progress" | "raw_sweep_referenced"): boolean {
	for (let current: unknown = error; current instanceof Error; current = current.cause) {
		if (current.message.includes(reason)) return true;
	}
	return false;
}

/**
 * Releases a stale, never-completed claim after confirming the object lookup succeeds: a present object
 * means the delete never ran (the orphan can be reclaimed again), a missing one means it effectively
 * ran (the marker is equivalent to a completed delete). A failed lookup leaves the state unknown, so
 * the marker is kept for a later pass.
 */
export async function releaseStalePendingDelete(env: CloudflareEnv, db: AppDb, marker: PendingDelete): Promise<boolean> {
	try {
		await env.BUCKET.get(marker.rawR2Key);
	} catch {
		return false;
	}
	const [released] = await db.delete(rawSweepPendingDeletes).where(and(
		eq(rawSweepPendingDeletes.rawR2Key, marker.rawR2Key),
		eq(rawSweepPendingDeletes.claimToken, marker.claimToken),
		eq(rawSweepPendingDeletes.claimedAt, marker.claimedAt),
		eq(rawSweepPendingDeletes.deleteComplete, false),
	)).returning({ rawR2Key: rawSweepPendingDeletes.rawR2Key });
	return !!released;
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
	const put = () => awaitOperation(env.BUCKET.put(rawR2Key, rawBytes, { httpMetadata: { contentType: "message/rfc822" } }));
	while (true) {
		if (!await awaitOperation(env.BUCKET.get(rawR2Key))) await put();
		try {
			return await insert(db);
		} catch (error) {
			if (!isRawSweepAbort(error, "raw_sweep_in_progress")) throw error;
		}
		// The insert hit a pending-delete marker: an object deletion happened or is in flight for this
		// key, so the bytes seen/stored above may be stale. Resolve the marker, then retry the whole
		// store + insert so the row commits against the generation that survives.
		while (true) {
			const [marker] = await db.select().from(rawSweepPendingDeletes)
				.where(eq(rawSweepPendingDeletes.rawR2Key, rawR2Key)).limit(1);
			if (!marker) break;
			if (Date.now() >= retryUntil) throw new Error("Raw object cleanup is in progress; inbound processing should retry");
			if (marker.deleteComplete) {
				// The recorded delete already ran; while the marker row exists no new claim can start,
				// so the re-stored bytes stay live until the insert commits. Consume the marker with
				// a guarded delete so a changed marker is re-read instead of lost.
				await put();
				const [consumed] = await db.delete(rawSweepPendingDeletes).where(and(
					eq(rawSweepPendingDeletes.rawR2Key, rawR2Key),
					eq(rawSweepPendingDeletes.claimToken, marker.claimToken),
					eq(rawSweepPendingDeletes.deleteComplete, true),
				)).returning({ rawR2Key: rawSweepPendingDeletes.rawR2Key });
				if (consumed) break;
				continue;
			}
			if (Date.now() - marker.claimedAt.getTime() >= STALE_PENDING_DELETE_MS) {
				if (await releaseStalePendingDelete(env, db, marker)) break;
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
		}
	}
}
