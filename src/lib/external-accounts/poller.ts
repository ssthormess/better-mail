import { and, asc, eq, gt, inArray, lte, notInArray, or, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, externalAccounts, mailboxes } from "@/db/schema";
import { kit } from "@/db/schema/kits";
import { decryptSecret } from "./crypto";
import { isSyncCursorFormat, SYNC_CURSOR_MAX_BYTES, SYNC_CURSOR_MAX_SKIPPED_UIDS, SYNC_CURSOR_MAX_UIDLS } from "./cursor";
import { fetchImap, IMAP_MAX_BATCH_BYTES, IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_MESSAGES_PER_POLL } from "./imap-client";
import { fetchPop3, POP3_MAX_BATCH_BYTES, POP3_MAX_MESSAGE_BYTES, POP3_MAX_MESSAGES_PER_POLL } from "./pop3-client";
import { inboundStorageKey } from "@/lib/email/inbound-id";
import { processInboundMessage } from "@/lib/email/inbound";
import { readHeaderMap } from "@/lib/email/provider-trace";

const INTERVAL_MS = 60_000;
const MAX_ACCOUNTS_PER_TICK = 10;
const MAX_TICK_MS = 50_000;
const CLAIM_LEASE_MS = 120_000;
const CLAIM_EXPIRY_GRACE_MS = 5_000;
const CLAIM_RENEW_MS = 20_000;
const IO_TIMEOUT_MS = 5_000;
const IMAP_SKIPPED_WARNING = "Oversized messages skipped; see skippedUids";
const POP3_SKIPPED_WARNING = "Oversized messages skipped; see skippedUidls";
const POLLED_PROTOCOLS = ["imap", "pop3"] as const;
type ImapCursor = { uidValidity: number; lastUid: number; skippedUids?: number[] };
type Pop3Cursor = { uidls: string[]; lastCheckedAt: string; skippedUidls?: string[] };
type FailureState = { count: number; retryAt: number };
const failures = new Map<string, FailureState>();
let pollTickInFlight = false;

function awaitBefore<T>(work: Promise<T>, deadlineAt: number, maxWaitMs = IO_TIMEOUT_MS): Promise<T> {
 const end = Math.min(deadlineAt, Date.now() + maxWaitMs);
 if (end <= Date.now()) { void work.catch(() => {}); return Promise.reject(new Error("timeout")); }
 let timer: ReturnType<typeof setTimeout> | undefined;
 return Promise.race([work, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), end - Date.now()); })])
  .finally(() => { if (timer) clearTimeout(timer); });
}

/** Runs only in Node. The database lease fences concurrent pollers across processes. */
export async function pollExternalAccounts(env: CloudflareEnv, now = new Date()) {
 if (env.MAILFLARE_RUNTIME !== "node") return { skipped: "runtime_unsupported", accounts: 0 };
 if (pollTickInFlight) return { skipped: "already_running", accounts: 0 };
 pollTickInFlight = true;
 const tickDeadline = Date.now() + MAX_TICK_MS;
 try {
  const db = getDb(env);
  const activeRows = await awaitBefore(db.select({ id: externalAccounts.id }).from(externalAccounts)
   .where(and(eq(externalAccounts.enabled, true), inArray(externalAccounts.protocol, POLLED_PROTOCOLS))), tickDeadline);
  const activeIds = new Set(activeRows.map(row => row.id));
  for (const id of failures.keys()) if (!activeIds.has(id)) failures.delete(id);
  const retryIds = [...failures].filter(([, state]) => state.retryAt > now.getTime()).map(([id]) => id);
  const claimAvailable = or(isNull(externalAccounts.pollClaimUntil), lte(externalAccounts.pollClaimUntil, kit.nowSeconds));
  const backoffAvailable = retryIds.length ? notInArray(externalAccounts.id, retryIds) : undefined;
  const rows = await awaitBefore(db.select({ account: externalAccounts, mailbox: mailboxes, domain: domains })
   .from(externalAccounts).innerJoin(mailboxes, eq(externalAccounts.mailboxId, mailboxes.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id))
   .where(and(
    eq(externalAccounts.enabled, true), inArray(externalAccounts.protocol, POLLED_PROTOCOLS),
    or(isNull(externalAccounts.lastSyncedAt), lte(externalAccounts.lastSyncedAt, new Date(now.getTime() - INTERVAL_MS))),
    claimAvailable,
    ...(backoffAvailable ? [backoffAvailable] : []),
   ))
   .orderBy(asc(sql`case when ${externalAccounts.lastSyncedAt} is null then 0 else 1 end`), asc(externalAccounts.lastSyncedAt))
   .limit(MAX_ACCOUNTS_PER_TICK), tickDeadline);
  let completed = 0;
  for (const row of rows) {
   if (Date.now() >= tickDeadline) break;
   const { account, mailbox, domain } = row;
   const claimToken = crypto.randomUUID();
   const sourceIdentity = and(
    eq(externalAccounts.mailboxId, account.mailboxId), eq(externalAccounts.protocol, account.protocol),
    eq(externalAccounts.host, account.host), eq(externalAccounts.port, account.port), eq(externalAccounts.tlsMode, account.tlsMode),
    eq(externalAccounts.username, account.username), eq(externalAccounts.passwordEncrypted, account.passwordEncrypted),
   );
   const originalCursor = account.syncCursor === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, account.syncCursor);
   const deadlineAt = Math.min(tickDeadline, Date.now() + 45_000);
   if (deadlineAt <= Date.now()) break;
   const cadenceDue = or(isNull(externalAccounts.lastSyncedAt), lte(externalAccounts.lastSyncedAt, new Date(now.getTime() - INTERVAL_MS)));
   const claimNow = new Date();
   let claimUntil = new Date(Math.min(claimNow.getTime() + CLAIM_LEASE_MS, deadlineAt + CLAIM_EXPIRY_GRACE_MS));
   let claim: { token: string | null } | undefined;
   try {
    await awaitBefore(db.update(externalAccounts).set({ pollClaimToken: claimToken, pollClaimUntil: claimUntil })
     .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true), sourceIdentity, originalCursor, cadenceDue,
      or(isNull(externalAccounts.pollClaimUntil), lte(externalAccounts.pollClaimUntil, kit.nowSeconds)))), deadlineAt);
    [claim] = await awaitBefore(db.select({ token: externalAccounts.pollClaimToken }).from(externalAccounts)
     .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.pollClaimToken, claimToken))).limit(1), deadlineAt);
   } catch { continue; }
   if (!claim) continue;

   let renewalInFlight: Promise<void> = Promise.resolve();
   let claimLost = false;
   const renewClaim = async () => {
    try {
     const currentTime = Date.now();
     if (currentTime >= deadlineAt || currentTime >= claimUntil.getTime()) { claimLost = true; return; }
     const until = new Date(Math.min(currentTime + CLAIM_LEASE_MS, deadlineAt + CLAIM_EXPIRY_GRACE_MS));
     await awaitBefore(db.update(externalAccounts).set({ pollClaimUntil: until })
      .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.pollClaimToken, claimToken), gt(externalAccounts.pollClaimUntil, kit.nowSeconds))), deadlineAt);
     const [owned] = await awaitBefore(db.select({ token: externalAccounts.pollClaimToken, until: externalAccounts.pollClaimUntil }).from(externalAccounts)
      .where(eq(externalAccounts.id, account.id)).limit(1), deadlineAt);
     if (owned?.token !== claimToken || !owned.until || owned.until.getTime() <= Date.now()) claimLost = true;
     else claimUntil = owned.until;
    } catch { claimLost = true; }
   };
   const heartbeat = setInterval(() => { renewalInFlight = renewalInFlight.then(renewClaim); }, CLAIM_RENEW_MS);
   let expectedCursorRaw = account.syncCursor;
   const progress = { skipped: false };
   const assertOwned = async () => {
    if (claimLost || Date.now() >= deadlineAt || Date.now() >= claimUntil.getTime()) throw new Error(Date.now() >= deadlineAt ? "timeout" : "account_changed");
    const [current] = await awaitBefore(db.select({
     enabled: externalAccounts.enabled, token: externalAccounts.pollClaimToken, claimUntil: externalAccounts.pollClaimUntil, host: externalAccounts.host,
     port: externalAccounts.port, protocol: externalAccounts.protocol, tlsMode: externalAccounts.tlsMode,
     username: externalAccounts.username, passwordEncrypted: externalAccounts.passwordEncrypted,
     mailboxId: externalAccounts.mailboxId, syncCursor: externalAccounts.syncCursor,
    }).from(externalAccounts).where(eq(externalAccounts.id, account.id)).limit(1), deadlineAt);
    if (!current?.enabled || current.token !== claimToken || !current.claimUntil || current.claimUntil.getTime() <= Date.now() || current.host !== account.host || current.port !== account.port
     || current.protocol !== account.protocol || current.tlsMode !== account.tlsMode || current.username !== account.username
     || current.passwordEncrypted !== account.passwordEncrypted || current.mailboxId !== account.mailboxId
     || current.syncCursor !== expectedCursorRaw) throw new Error("account_changed");
   };
   const guardedUpdate = async (values: { syncCursor?: string; lastSyncedAt?: Date; lastError: string | null }) => {
    const changed = await awaitBefore(db.update(externalAccounts).set(values).where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true),
     eq(externalAccounts.pollClaimToken, claimToken), gt(externalAccounts.pollClaimUntil, kit.nowSeconds), sourceIdentity,
     expectedCursorRaw === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, expectedCursorRaw)))
     .returning({ id: externalAccounts.id }), deadlineAt);
    if (changed.length !== 1) throw new Error("account_changed");
   };
   /** Writes a committed cursor plus the sync stamp; every value passes through the protocol's bounded codec check. */
   const setState = async (encodedCursor: string, lastError: string | null) => {
    await assertOwned();
    if (!isSyncCursorFormat(encodedCursor, account.protocol)) throw new Error("invalid_cursor");
    await guardedUpdate({ syncCursor: encodedCursor, lastSyncedAt: now, lastError });
    expectedCursorRaw = encodedCursor;
   };
   /** Advances the sync stamp and error surface without moving the cursor; same compare-and-update fence. */
   const touchState = async (lastError: string | null) => {
    await assertOwned();
    await guardedUpdate({ lastSyncedAt: now, lastError });
   };
   /**
    * One fetched message through the canonical inbound consumer: content-addressed raw object, then intake with
    * side effects suppressed. Content-addressed raw objects may already be referenced by a stored message on
    * replay; a timed-out PUT is an acceptable orphan, deleting it could break that existing message.
    */
   const storeRaw = async (raw: Buffer) => {
    const rawBytes = new Uint8Array(raw.byteLength); rawBytes.set(raw); const rawBuffer = rawBytes.buffer;
    const rawR2Key = await inboundStorageKey(rawBuffer, mailbox.id);
    await assertOwned();
    await awaitBefore(env.BUCKET.put(rawR2Key, rawBuffer, { httpMetadata: { contentType: "message/rfc822" } }), deadlineAt);
    const headers = readHeaderMap(rawBuffer);
    await assertOwned();
    await awaitBefore(processInboundMessage(env, { from: headers.from ?? "", to: `${mailbox.localPart}@${domain.hostname}`, rawR2Key, headers }, { intakeMode: "historical_import", deadlineAt, rawBytes: rawBuffer }), deadlineAt);
    await assertOwned();
   };
   try {
    await assertOwned();
    const secret = await decryptSecret(env, account.passwordEncrypted);
    if (account.protocol === "pop3") {
     const initialCursor = account.syncCursor === null ? null : isSyncCursorFormat(account.syncCursor, "pop3") ? JSON.parse(account.syncCursor) as Pop3Cursor : null;
     const seenOrder = Array.isArray(initialCursor?.uidls) ? [...initialCursor.uidls] : [];
     const skippedOrder = Array.isArray(initialCursor?.skippedUidls) ? [...initialCursor.skippedUidls] : [];
     const seen = new Set(seenOrder);
     const skipped = new Set(skippedOrder);
     progress.skipped = skippedOrder.length > 0;
     /**
      * Trims each set at its count cap (oldest first), then trims further until the encoded cursor fits the
      * 64 KiB byte bound — sha256-hex UIDLs make the byte bound the effective cap well before the count one.
      * A UIDL evicted past either cap refetches and dedups on the raw key; skipped diagnostics are the cheaper
      * loss, so they evict before the dedup set does.
      */
     const commit = async () => {
      while (seenOrder.length > SYNC_CURSOR_MAX_UIDLS) seen.delete(seenOrder.shift()!);
      while (skippedOrder.length > SYNC_CURSOR_MAX_SKIPPED_UIDS) skipped.delete(skippedOrder.shift()!);
      const encode = () => JSON.stringify({ uidls: seenOrder, lastCheckedAt: now.toISOString(), ...(skippedOrder.length ? { skippedUidls: skippedOrder } : {}) } satisfies Pop3Cursor);
      let encoded = encode();
      while (new TextEncoder().encode(encoded).byteLength > SYNC_CURSOR_MAX_BYTES) {
       if (skippedOrder.length) skipped.delete(skippedOrder.shift()!);
       else if (seenOrder.length) seen.delete(seenOrder.shift()!);
       else break;
       encoded = encode();
      }
      await setState(encoded, skippedOrder.length ? POP3_SKIPPED_WARNING : null);
     };
     await fetchPop3({
      host: account.host, port: account.port, tlsMode: account.tlsMode, username: account.username, password: secret,
      allowPrivate: env.EXTERNAL_FETCH_ALLOW_PRIVATE === "1",
     }, seen, skipped, POP3_MAX_MESSAGES_PER_POLL, POP3_MAX_MESSAGE_BYTES, {
      maxBatchBytes: POP3_MAX_BATCH_BYTES,
      deadlineAt,
      onMessage: async event => {
       await assertOwned();
       if ("outcome" in event) {
        if (!skipped.has(event.uidlHash)) { skipped.add(event.uidlHash); skippedOrder.push(event.uidlHash); }
        progress.skipped = true;
       } else {
        await storeRaw(event.raw);
        if (!seen.has(event.uidlHash)) { seen.add(event.uidlHash); seenOrder.push(event.uidlHash); }
       }
       await commit();
      },
     });
     await assertOwned();
     await commit();
    } else {
     let committedCursor: ImapCursor | null = null;
     const initialCursor = account.syncCursor === null ? null : isSyncCursorFormat(account.syncCursor, "imap") ? JSON.parse(account.syncCursor) as ImapCursor : null;
     const validCursor = initialCursor && Number.isInteger(initialCursor.uidValidity) && initialCursor.uidValidity > 0
      && initialCursor.uidValidity <= 0xffff_ffff && Number.isInteger(initialCursor.lastUid) && initialCursor.lastUid >= 0
      && initialCursor.lastUid <= 0xffff_ffff ? initialCursor : null;
     committedCursor = validCursor;
     progress.skipped = Boolean(validCursor?.skippedUids?.length);
     const commitImap = async (cursor: ImapCursor) => {
      await setState(JSON.stringify(cursor), cursor.skippedUids?.length ? IMAP_SKIPPED_WARNING : null);
      committedCursor = cursor;
     };
     const fetchResult = await fetchImap({
      host: account.host, port: account.port, tlsMode: account.tlsMode, username: account.username, password: secret,
      allowPrivate: env.EXTERNAL_FETCH_ALLOW_PRIVATE === "1",
     }, validCursor ? { uidValidity: validCursor.uidValidity, lastUid: validCursor.lastUid } : null,
     IMAP_MAX_MESSAGES_PER_POLL, IMAP_MAX_MESSAGE_BYTES, {
      maxBatchBytes: IMAP_MAX_BATCH_BYTES,
      deadlineAt,
      onMessage: async event => {
       await assertOwned();
       const skippedUids = committedCursor?.uidValidity === event.uidValidity ? [...(committedCursor.skippedUids ?? [])] : [];
       if ("outcome" in event && event.outcome === "oversized") {
        skippedUids.push(event.uid);
        if (skippedUids.length > SYNC_CURSOR_MAX_SKIPPED_UIDS) skippedUids.splice(0, skippedUids.length - SYNC_CURSOR_MAX_SKIPPED_UIDS);
        progress.skipped = true;
       } else if (!("outcome" in event)) {
        await storeRaw(event.raw);
       }
       const lastUid = Math.max(committedCursor?.uidValidity === event.uidValidity ? committedCursor.lastUid : 0, event.uid);
       await commitImap({ uidValidity: event.uidValidity, lastUid, ...(skippedUids.length ? { skippedUids } : {}) });
      },
     });
     await assertOwned();
     const completedCursor: ImapCursor = committedCursor?.uidValidity === fetchResult.uidValidity
      ? committedCursor
      : { uidValidity: fetchResult.uidValidity, lastUid: fetchResult.lastUid };
     const encoded = JSON.stringify(completedCursor);
     if (encoded !== expectedCursorRaw) await setState(encoded, completedCursor.skippedUids?.length ? IMAP_SKIPPED_WARNING : null);
     else await touchState(completedCursor.skippedUids?.length ? IMAP_SKIPPED_WARNING : null);
    }
    failures.delete(account.id);
    completed++;
   } catch (error) {
    const count = (failures.get(account.id)?.count ?? 0) + 1;
    const delay = Math.min(30 * 60_000, INTERVAL_MS * 2 ** Math.min(count, 5));
    failures.set(account.id, { count, retryAt: now.getTime() + delay });
    const label = account.protocol === "pop3" ? "POP3" : "IMAP";
    const skippedField = account.protocol === "pop3" ? "skippedUidls" : "skippedUids";
    const message = error instanceof Error && error.message === "authentication_failed" ? "Authentication failed"
     : error instanceof Error && error.message === "egress_denied" ? "Outbound destination denied by fetch egress policy"
     : error instanceof Error && error.message === "credentials_unsupported" ? `${label} credentials contain unsupported characters`
     : error instanceof Error && error.message === "uidl_unsupported" ? "POP3 server does not support UIDL and cannot be polled"
     : progress.skipped ? `${label} poll failed; see ${skippedField} for previously skipped messages`
     : `${label} poll failed; retry is backed off`;
    await awaitBefore(db.update(externalAccounts).set({ lastError: message, lastSyncedAt: now })
     .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.pollClaimToken, claimToken), gt(externalAccounts.pollClaimUntil, kit.nowSeconds), sourceIdentity)), deadlineAt).catch(() => {});
   } finally {
    if (heartbeat) clearInterval(heartbeat);
    await awaitBefore(renewalInFlight, tickDeadline, 1_000).catch(() => {});
    await awaitBefore(db.update(externalAccounts).set({ pollClaimToken: null, pollClaimUntil: null })
     .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.pollClaimToken, claimToken))), tickDeadline, 1_000).catch(() => {});
   }
  }
  return { accounts: completed };
 } finally {
  pollTickInFlight = false;
 }
}
