import { and, asc, eq, lte, or, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, externalAccounts, mailboxes } from "@/db/schema";
import { decryptSecret } from "./crypto";
import { isSyncCursorFormat, SYNC_CURSOR_MAX_SKIPPED_UIDS } from "./cursor";
import { fetchImap, IMAP_MAX_BATCH_BYTES, IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_MESSAGES_PER_POLL } from "./imap-client";
import { inboundStorageKey } from "@/lib/email/inbound-id";
import { processInboundMessage } from "@/lib/email/inbound";
import { readHeaderMap } from "@/lib/email/provider-trace";

const INTERVAL_MS = 60_000;
const MAX_ACCOUNTS_PER_TICK = 10;
const MAX_TICK_MS = 50_000;
const inFlightAccounts = new Set<string>();
const failures = new Map<string, number>();
let pollTickInFlight = false;
type ImapCursor = { uidValidity: number; lastUid: number; skippedUids?: number[] };

/** Runs only in Node. A single process-wide guard prevents overlapping scheduler ticks. */
export async function pollExternalImapAccounts(env: CloudflareEnv, now = new Date()) {
 if (env.MAILFLARE_RUNTIME !== "node") return { skipped: "runtime_unsupported", accounts: 0 };
 if (pollTickInFlight) return { skipped: "already_running", accounts: 0 };
 pollTickInFlight = true;
 const tickStartedAt = Date.now();
 try {
  const db = getDb(env); const cutoff = new Date(now.getTime() - INTERVAL_MS);
  // Overfetch so old rows in backoff/in-flight do not starve later eligible accounts; CASE makes NULL first on every dialect.
  const rows = await db.select({ account: externalAccounts, mailbox: mailboxes, domain: domains })
   .from(externalAccounts).innerJoin(mailboxes, eq(externalAccounts.mailboxId, mailboxes.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id))
   .where(and(eq(externalAccounts.enabled, true), eq(externalAccounts.protocol, "imap"), or(isNull(externalAccounts.lastSyncedAt), lte(externalAccounts.lastSyncedAt, cutoff))))
   .orderBy(asc(sql`case when ${externalAccounts.lastSyncedAt} is null then 0 else 1 end`), asc(externalAccounts.lastSyncedAt)).limit(1000);
  let completed = 0; let attempted = 0;
  for (const row of rows) {
   if (attempted >= MAX_ACCOUNTS_PER_TICK || Date.now() - tickStartedAt >= MAX_TICK_MS) break;
   const { account, mailbox, domain } = row;
   if (inFlightAccounts.has(account.id)) continue;
   const backoff = Math.min(30 * 60_000, INTERVAL_MS * 2 ** Math.min(failures.get(account.id) ?? 0, 5));
   if (account.lastSyncedAt && now.getTime() - account.lastSyncedAt.getTime() < backoff) continue;
   inFlightAccounts.add(account.id); attempted++;
   let expectedUpdatedAt = account.updatedAt;
   let expectedCursorRaw = account.syncCursor;
   try {
    const dbAccount = await db.select({ id: externalAccounts.id, enabled: externalAccounts.enabled, updatedAt: externalAccounts.updatedAt, syncCursor: externalAccounts.syncCursor, passwordEncrypted: externalAccounts.passwordEncrypted }).from(externalAccounts).where(eq(externalAccounts.id, account.id)).limit(1);
    const live = dbAccount[0];
    if (!live || !live.enabled || live.updatedAt.getTime() !== account.updatedAt.getTime() || live.syncCursor !== account.syncCursor || live.passwordEncrypted !== account.passwordEncrypted) continue;
    const initialCursor = account.syncCursor === null ? null : isSyncCursorFormat(account.syncCursor, "imap") ? JSON.parse(account.syncCursor) as ImapCursor : null;
    const validCursor = initialCursor && Number.isInteger(initialCursor.uidValidity) && initialCursor.uidValidity > 0 && initialCursor.uidValidity <= 0xffff_ffff && Number.isInteger(initialCursor.lastUid) && initialCursor.lastUid >= 0 && initialCursor.lastUid <= 0xffff_ffff ? initialCursor : null;
    const secret = await decryptSecret(env, account.passwordEncrypted);
    let committedCursor: ImapCursor | null = validCursor;
    let skippedAny = false;
    const setState = async (cursor: ImapCursor, clearError: boolean) => {
     const encoded = JSON.stringify(cursor);
     if (!isSyncCursorFormat(encoded, "imap")) throw new Error("invalid_cursor");
     const writeAt = new Date(Math.ceil(Math.max(now.getTime(), expectedUpdatedAt.getTime() + 1000) / 1000) * 1000);
     const expectedCursorCondition = expectedCursorRaw === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, expectedCursorRaw);
     const changed = await db.update(externalAccounts).set({ syncCursor: encoded, lastSyncedAt: now, ...(clearError ? { lastError: null } : {}), updatedAt: writeAt })
      .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true), eq(externalAccounts.updatedAt, expectedUpdatedAt), expectedCursorCondition))
      .returning({ id: externalAccounts.id });
     if (changed.length !== 1) throw new Error("account_changed");
     expectedUpdatedAt = writeAt; expectedCursorRaw = encoded; committedCursor = cursor;
    };
    const fetchResult = await fetchImap({
     host: account.host, port: account.port, tlsMode: account.tlsMode, username: account.username, password: secret,
     allowPrivate: env.EXTERNAL_FETCH_ALLOW_PRIVATE === "1",
    }, validCursor ? { uidValidity: validCursor.uidValidity, lastUid: validCursor.lastUid } : null, IMAP_MAX_MESSAGES_PER_POLL, IMAP_MAX_MESSAGE_BYTES, {
     maxBatchBytes: IMAP_MAX_BATCH_BYTES,
     onMessage: async event => {
      // Check for disable/edit after dialing and before every store; the cursor write below is the CAS fence.
      const [current] = await db.select({ enabled: externalAccounts.enabled, updatedAt: externalAccounts.updatedAt, syncCursor: externalAccounts.syncCursor }).from(externalAccounts).where(eq(externalAccounts.id, account.id)).limit(1);
      if (!current?.enabled || current.updatedAt.getTime() !== expectedUpdatedAt.getTime() || current.syncCursor !== expectedCursorRaw) throw new Error("account_changed");
      let skippedUids = committedCursor?.uidValidity === event.uidValidity ? [...(committedCursor?.skippedUids ?? [])] : [];
      if ("skipped" in event) {
       skippedAny = true;
       skippedUids = [...skippedUids.filter(uid => uid !== event.uid), event.uid].slice(-SYNC_CURSOR_MAX_SKIPPED_UIDS);
      } else {
       const rawBytes = new Uint8Array(event.raw.byteLength); rawBytes.set(event.raw); const rawBuffer = rawBytes.buffer;
       const rawR2Key = await inboundStorageKey(rawBuffer, mailbox.id);
       await env.BUCKET.put(rawR2Key, rawBuffer, { httpMetadata: { contentType: "message/rfc822" } });
       const headers = readHeaderMap(rawBuffer);
       await processInboundMessage(env, { from: headers.from ?? "", to: `${mailbox.localPart}@${domain.hostname}`, rawR2Key, headers }, { suppressSideEffects: true });
      }
      const lastUid = Math.max(committedCursor?.uidValidity === event.uidValidity ? committedCursor.lastUid : 0, event.uid);
      const nextCursor: ImapCursor = { uidValidity: event.uidValidity, lastUid, ...(skippedUids.length ? { skippedUids } : {}) };
      await setState(nextCursor, false);
     },
    });
    if (Date.now() - tickStartedAt >= MAX_TICK_MS) throw new Error("timeout");
    // A UIDVALIDITY change with an empty mailbox still requires replacing the old epoch cursor.
    const completedCursor: ImapCursor = committedCursor?.uidValidity === fetchResult.uidValidity
     ? committedCursor
     : { uidValidity: fetchResult.uidValidity, lastUid: 0 };
    if (JSON.stringify(completedCursor) !== expectedCursorRaw || skippedAny || account.lastError !== null) await setState(completedCursor, !skippedAny);
    else {
     const expectedCursorCondition = expectedCursorRaw === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, expectedCursorRaw);
     const writeAt = new Date(Math.ceil(Math.max(now.getTime(), expectedUpdatedAt.getTime() + 1000) / 1000) * 1000);
     const changed = await db.update(externalAccounts).set({ lastSyncedAt: now, lastError: null, updatedAt: writeAt }).where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true), eq(externalAccounts.updatedAt, expectedUpdatedAt), expectedCursorCondition)).returning({ id: externalAccounts.id });
     if (changed.length !== 1) throw new Error("account_changed");
     expectedUpdatedAt = writeAt;
    }
    if (skippedAny) {
     const writeAt = new Date(Math.ceil(Math.max(now.getTime(), expectedUpdatedAt.getTime() + 1000) / 1000) * 1000);
     const changed = await db.update(externalAccounts).set({ lastError: "Oversized messages skipped; see sync cursor skippedUids", updatedAt: writeAt })
      .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true), eq(externalAccounts.updatedAt, expectedUpdatedAt), eq(externalAccounts.syncCursor, JSON.stringify(completedCursor)))).returning({ id: externalAccounts.id });
     if (changed.length === 1) expectedUpdatedAt = writeAt;
    }
    failures.delete(account.id); completed++;
   } catch (error) {
    const count = (failures.get(account.id) ?? 0) + 1; failures.set(account.id, count);
    const message = error instanceof Error && error.message === "authentication_failed" ? "Authentication failed" : error instanceof Error && error.message === "message_too_large" ? "Message exceeds the per-message fetch limit" : error instanceof Error && error.message === "egress_denied" ? "Outbound destination denied by fetch egress policy" : error instanceof Error && error.message === "credentials_unsupported" ? "IMAP credentials contain unsupported characters" : "IMAP poll failed; retry is backed off";
    // This CAS refuses to overwrite a concurrent edit/disable or another poller's newer cursor.
    const expectedCursorCondition = expectedCursorRaw === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, expectedCursorRaw);
    await db.update(externalAccounts).set({ lastError: message, lastSyncedAt: now, updatedAt: new Date(Math.ceil(Math.max(now.getTime(), expectedUpdatedAt.getTime() + 1000) / 1000) * 1000) })
     .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true), eq(externalAccounts.updatedAt, expectedUpdatedAt), expectedCursorCondition));
   } finally { inFlightAccounts.delete(account.id); }
  }
  return { accounts: completed };
 } finally { pollTickInFlight = false; }
}
