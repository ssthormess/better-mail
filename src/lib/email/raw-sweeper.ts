import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, messages } from "@/db/schema";
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
const LOOKUP_BATCH = 50;
const SWEEP_CURSOR_SETTINGS_ID = "default";

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
	let cursor = await readSweepCursor(db);
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const previousCursor = cursor;
		const listing = await env.BUCKET.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}), limit: PAGE });
		const old = listing.objects.filter((object) => now.getTime() - object.uploaded.getTime() > MIN_AGE_MS).map((object) => object.key);
		const orphans: string[] = [];
		for (let index = 0; index < old.length; index += LOOKUP_BATCH) {
			const batch = old.slice(index, index + LOOKUP_BATCH);
			const referenced = await db.select({ key: messages.rawR2Key }).from(messages).where(inArray(messages.rawR2Key, batch));
			const kept = new Set(referenced.map((row) => row.key));
			orphans.push(...batch.filter((key) => !kept.has(key)));
		}
		if (orphans.length) {
			await env.BUCKET.delete(orphans);
			removed += orphans.length;
		}
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
