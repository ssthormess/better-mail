import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, messages, rawSweepPendingDeletes } from "@/db/schema";
import { isExternalDatabase } from "@/db/external";
import { newId } from "@/lib/ids";
import { isRawSweepAbort, lockRawSweepFence, releaseStalePendingDelete, STALE_PENDING_DELETE_MS, withRawSweepTransaction } from "@/lib/email/raw-object-fence";
import { INBOUND_SIGNATURE_MAX_AGE_SECONDS } from "@/lib/email/intake-signature";
import { SNS_MAX_AGE_MS } from "@/lib/aws/sns-signature";
import { UPLOAD_PREFIX } from "@/lib/jmap/blobs";
import { sweepStaleObjects } from "@/lib/email/stale-objects";
import { REQUEST_UPLOAD_PREFIX } from "@/lib/uploads/constants";

const PREFIX = "inbound/";
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const PAGE = 100;
const MAX_PAGES = 20;
/**
 * Prefixes that only need an age-based sweep. The relay and SNS intake routes write one dedupe object per request
 * and accept timestamps up to their window in the past or future, so those are kept for twice the window plus an
 * hour of margin.
 */
const HOUR_MS = 60 * 60 * 1000;
const STALE_PREFIXES: Array<{ prefix: string; maxAgeMs: number }> = [
	{ prefix: "relay-seen/", maxAgeMs: 2 * INBOUND_SIGNATURE_MAX_AGE_SECONDS * 1000 + HOUR_MS },
	{ prefix: "sns-seen/", maxAgeMs: 2 * SNS_MAX_AGE_MS + HOUR_MS },
	// JMAP uploads an Email/set create has claimed are copied into the draft; unclaimed ones are abandoned.
	{ prefix: `${UPLOAD_PREFIX}/`, maxAgeMs: 7 * 24 * HOUR_MS },
	// Direct uploads (Vercel) are deleted once their request reads them; the rest were abandoned.
	{ prefix: `${REQUEST_UPLOAD_PREFIX}/`, maxAgeMs: 24 * HOUR_MS },
];
/** D1 allows 100 bound parameters per statement. */
const SWEEP_CURSOR_SETTINGS_ID = "default";
const PENDING_RECOVERY_LIMIT = 100;

async function readSweepCursor(db: ReturnType<typeof getDb>): Promise<string | null> {
	await db.insert(appSettings).values({ id: SWEEP_CURSOR_SETTINGS_ID }).onConflictDoNothing();
	const [settings] = await db.select({ cursor: appSettings.rawMailSweepCursor }).from(appSettings)
		.where(eq(appSettings.id, SWEEP_CURSOR_SETTINGS_ID)).limit(1);
	return settings?.cursor ?? null;
}

async function advanceSweepCursor(db: ReturnType<typeof getDb>, previous: string | null, next: string | null): Promise<boolean> {
	const previousMatch = previous === null ? isNull(appSettings.rawMailSweepCursor) : eq(appSettings.rawMailSweepCursor, previous);
	const [updated] = await db.update(appSettings).set({ rawMailSweepCursor: next })
		.where(and(eq(appSettings.id, SWEEP_CURSOR_SETTINGS_ID), previousMatch))
		.returning({ id: appSettings.id });
	return !!updated;
}

function isInvalidSweepCursorError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown }; message?: unknown };
	const code = [value.name, value.code].find((item) => typeof item === "string");
	const status = value.statusCode ?? value.status ?? value.$metadata?.httpStatusCode;
	const message = typeof value.message === "string" ? value.message : "";
	return (typeof code === "string" && ["InvalidArgument", "InvalidContinuationToken", "InvalidToken"].includes(code)
		&& /continuation|cursor|token/i.test(message))
		|| (Number(status) === 400 && /invalid|incorrect|malformed/i.test(message) && /continuation token|cursor/i.test(message));
}

async function deleteCandidate(env: CloudflareEnv, db: ReturnType<typeof getDb>, key: string, now: Date): Promise<boolean> {
	const atomic = await withRawSweepTransaction(env, async (tx) => {
		await lockRawSweepFence(tx);
		const [reference] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.rawR2Key, key)).limit(1);
		if (reference) return false;
		await env.BUCKET.delete(key);
		return true;
	});
	if (atomic.supported) return atomic.value;
	// External HTTP drivers without transactions are fail-closed: they cannot hold the SQL fence
	// across the object-store delete. D1 uses a SQLite trigger/marker to make this two-phase path safe.
	if (isExternalDatabase(env.DB)) return false;

	// Referenced keys are the common case on a populated mailbox, so they get a cheap read instead of
	// the claim insert; the insert trigger still guards the read→claim gap atomically, and its abort
	// arrives wrapped in DrizzleQueryError, so it is matched through the error's cause chain.
	const [reference] = await db.select({ id: messages.id }).from(messages).where(eq(messages.rawR2Key, key)).limit(1);
	if (reference) return false;
	const claimToken = newId();
	let claim: { rawR2Key: string } | undefined;
	try {
		[claim] = await db.insert(rawSweepPendingDeletes).values({ rawR2Key: key, claimToken, claimedAt: now })
			.onConflictDoNothing().returning({ rawR2Key: rawSweepPendingDeletes.rawR2Key });
	} catch (error) {
		if (isRawSweepAbort(error, "raw_sweep_referenced")) return false;
		throw error;
	}
	if (!claim) return false;
	await env.BUCKET.delete(key);
	const [completed] = await db.update(rawSweepPendingDeletes).set({ deleteComplete: true }).where(and(
		eq(rawSweepPendingDeletes.rawR2Key, key), eq(rawSweepPendingDeletes.claimToken, claimToken),
	)).returning({ rawR2Key: rawSweepPendingDeletes.rawR2Key });
	if (!completed) throw new Error("Raw object delete claim changed before completion was recorded");
	// The completed marker stays: it still fences a racing intake's insert until that intake consumes
	// it, and the next sweep's recovery clears it.
	return true;
}

async function recoverStalePendingDeletes(env: CloudflareEnv, db: ReturnType<typeof getDb>, now: Date): Promise<void> {
	if (isExternalDatabase(env.DB)) return;
	const cutoff = new Date(now.getTime() - STALE_PENDING_DELETE_MS);
	// A marker this old cannot still have a `BUCKET.delete` in flight. Completed markers only need their
	// row cleared; unfinished ones get a guarded release so the orphan can be claimed again instead of
	// wedging the key forever.
	const stale = await db.select().from(rawSweepPendingDeletes).where(
		lt(rawSweepPendingDeletes.claimedAt, cutoff),
	).limit(PENDING_RECOVERY_LIMIT);
	for (const row of stale) {
		if (row.deleteComplete) {
			await db.delete(rawSweepPendingDeletes).where(and(
				eq(rawSweepPendingDeletes.rawR2Key, row.rawR2Key),
				eq(rawSweepPendingDeletes.claimToken, row.claimToken),
				eq(rawSweepPendingDeletes.deleteComplete, true),
			));
		} else {
			await releaseStalePendingDelete(env, db, row);
		}
	}
}

/**
 * Deletes raw MIME under `inbound/` that no stored message refers to and that is old enough
 * that its queue message is long finished. Its bounded listing cursor is persisted after each page,
 * so successive invocations cover the key-sorted bucket and wrap to the start when a pass completes.
 * New keys sorting before a saved cursor wait for the next pass. Afterwards it removes stale relay/SNS
 * dedupe objects and old JMAP uploads.
 */
export async function sweepOrphanedRawMail(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	let removed = 0;
	await recoverStalePendingDeletes(env, db, now);
	let cursor = await readSweepCursor(db);
	for (let page = 0; page < MAX_PAGES; page += 1) {
		let previousCursor = cursor;
		let listing: Awaited<ReturnType<CloudflareEnv["BUCKET"]["list"]>>;
		try {
			listing = await env.BUCKET.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}), limit: PAGE });
		} catch (error) {
			if (!cursor || !isInvalidSweepCursorError(error)) throw error;
			if (!await advanceSweepCursor(db, cursor, null)) break;
			cursor = null;
			previousCursor = null;
			listing = await env.BUCKET.list({ prefix: PREFIX, limit: PAGE });
		}
		const old = listing.objects.filter((object) => now.getTime() - object.uploaded.getTime() > MIN_AGE_MS).map((object) => object.key);
		for (const key of old) if (await deleteCandidate(env, db, key, now)) removed += 1;
		if (listing.truncated && !listing.cursor) throw new Error("Raw mail listing was truncated without a continuation cursor");
		const nextCursor = listing.truncated ? listing.cursor! : null;
		if (listing.truncated && nextCursor === previousCursor) throw new Error("Raw mail listing did not advance its continuation cursor");
		if (nextCursor !== previousCursor && !await advanceSweepCursor(db, previousCursor, nextCursor)) break;
		cursor = nextCursor;
		if (!listing.truncated) break;
	}
	// After the main sweep, so a backlog under these prefixes cannot use up its request budget.
	for (const { prefix, maxAgeMs } of STALE_PREFIXES) {
		await sweepStaleObjects(env.BUCKET, prefix, maxAgeMs, now).catch((error) => console.error(`Sweep of ${prefix} failed`, error));
	}
	return removed;
}
