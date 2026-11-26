import { and, asc, eq, gt, lte, notInArray, or, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, externalAccounts, mailboxes } from "@/db/schema";
import { kit } from "@/db/schema/kits";
import { decryptSecret } from "./crypto";
import { isSyncCursorFormat, SYNC_CURSOR_MAX_SKIPPED_UIDS } from "./cursor";
import { fetchImap, IMAP_MAX_BATCH_BYTES, IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_MESSAGES_PER_POLL } from "./imap-client";
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
const SKIPPED_WARNING = "Oversized messages skipped; see skippedUids";
type ImapCursor = { uidValidity: number; lastUid: number; skippedUids?: number[] };
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
export async function pollExternalImapAccounts(env: CloudflareEnv, now = new Date()) {
 if (env.MAILFLARE_RUNTIME !== "node") return { skipped: "runtime_unsupported", accounts: 0 };
 if (pollTickInFlight) return { skipped: "already_running", accounts: 0 };
 pollTickInFlight = true;
 const tickDeadline = Date.now() + MAX_TICK_MS;
 try {
  const db = getDb(env);
  const activeRows = await awaitBefore(db.select({ id: externalAccounts.id }).from(externalAccounts)
   .where(and(eq(externalAccounts.enabled, true), eq(externalAccounts.protocol, "imap"))), tickDeadline);
  const activeIds = new Set(activeRows.map(row => row.id));
  for (const id of failures.keys()) if (!activeIds.has(id)) failures.delete(id);
  const retryIds = [...failures].filter(([, state]) => state.retryAt > now.getTime()).map(([id]) => id);
  const claimAvailable = or(isNull(externalAccounts.pollClaimUntil), lte(externalAccounts.pollClaimUntil, kit.nowSeconds));
  const backoffAvailable = retryIds.length ? notInArray(externalAccounts.id, retryIds) : undefined;
  const rows = await awaitBefore(db.select({ account: externalAccounts, mailbox: mailboxes, domain: domains })
   .from(externalAccounts).innerJoin(mailboxes, eq(externalAccounts.mailboxId, mailboxes.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id))
   .where(and(
    eq(externalAccounts.enabled, true), eq(externalAccounts.protocol, "imap"),
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
   let committedCursor: ImapCursor | null = null;
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
   const setState = async (cursor: ImapCursor) => {
    await assertOwned();
    const encoded = JSON.stringify(cursor);
    if (!isSyncCursorFormat(encoded, "imap")) throw new Error("invalid_cursor");
    const changed = await awaitBefore(db.update(externalAccounts).set({
     syncCursor: encoded, lastSyncedAt: now,
     lastError: cursor.skippedUids?.length ? SKIPPED_WARNING : null,
    }).where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true),
     eq(externalAccounts.pollClaimToken, claimToken), gt(externalAccounts.pollClaimUntil, kit.nowSeconds), sourceIdentity,
     expectedCursorRaw === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, expectedCursorRaw)))
     .returning({ id: externalAccounts.id }), deadlineAt);
    if (changed.length !== 1) throw new Error("account_changed");
    expectedCursorRaw = encoded;
    committedCursor = cursor;
   };
   try {
    await assertOwned();
    const initialCursor = account.syncCursor === null ? null : isSyncCursorFormat(account.syncCursor, "imap") ? JSON.parse(account.syncCursor) as ImapCursor : null;
    const validCursor = initialCursor && Number.isInteger(initialCursor.uidValidity) && initialCursor.uidValidity > 0
     && initialCursor.uidValidity <= 0xffff_ffff && Number.isInteger(initialCursor.lastUid) && initialCursor.lastUid >= 0
     && initialCursor.lastUid <= 0xffff_ffff ? initialCursor : null;
    committedCursor = validCursor;
    const secret = await decryptSecret(env, account.passwordEncrypted);
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
      } else if (!("outcome" in event)) {
       const rawBytes = new Uint8Array(event.raw.byteLength); rawBytes.set(event.raw); const rawBuffer = rawBytes.buffer;
       const rawR2Key = await inboundStorageKey(rawBuffer, mailbox.id);
       await assertOwned();
       // Content-addressed raw objects may already be referenced by a stored message on replay. A timed-out
       // PUT is an acceptable orphan; deleting it could break that existing message.
       await awaitBefore(env.BUCKET.put(rawR2Key, rawBuffer, { httpMetadata: { contentType: "message/rfc822" } }), deadlineAt);
       const headers = readHeaderMap(rawBuffer);
       await assertOwned();
       await awaitBefore(processInboundMessage(env, { from: headers.from ?? "", to: `${mailbox.localPart}@${domain.hostname}`, rawR2Key, headers }, { intakeMode: "historical_import", deadlineAt, rawBytes: rawBuffer }), deadlineAt);
       await assertOwned();
      }
      const lastUid = Math.max(committedCursor?.uidValidity === event.uidValidity ? committedCursor.lastUid : 0, event.uid);
      await setState({ uidValidity: event.uidValidity, lastUid, ...(skippedUids.length ? { skippedUids } : {}) });
     },
    });
    await assertOwned();
    const completedCursor: ImapCursor = committedCursor?.uidValidity === fetchResult.uidValidity
     ? committedCursor
     : { uidValidity: fetchResult.uidValidity, lastUid: fetchResult.lastUid };
    if (JSON.stringify(completedCursor) !== expectedCursorRaw) await setState(completedCursor);
    else {
     const changed = await awaitBefore(db.update(externalAccounts).set({ lastSyncedAt: now, lastError: completedCursor.skippedUids?.length ? SKIPPED_WARNING : null })
      .where(and(eq(externalAccounts.id, account.id), eq(externalAccounts.enabled, true), eq(externalAccounts.pollClaimToken, claimToken), gt(externalAccounts.pollClaimUntil, kit.nowSeconds), sourceIdentity,
       expectedCursorRaw === null ? isNull(externalAccounts.syncCursor) : eq(externalAccounts.syncCursor, expectedCursorRaw)))
      .returning({ id: externalAccounts.id }), deadlineAt);
     if (changed.length !== 1) throw new Error("account_changed");
    }
    failures.delete(account.id);
    completed++;
   } catch (error) {
    const count = (failures.get(account.id)?.count ?? 0) + 1;
    const delay = Math.min(30 * 60_000, INTERVAL_MS * 2 ** Math.min(count, 5));
    failures.set(account.id, { count, retryAt: now.getTime() + delay });
    const message = error instanceof Error && error.message === "authentication_failed" ? "Authentication failed"
     : error instanceof Error && error.message === "egress_denied" ? "Outbound destination denied by fetch egress policy"
     : error instanceof Error && error.message === "credentials_unsupported" ? "IMAP credentials contain unsupported characters"
     : committedCursor?.skippedUids?.length ? "IMAP poll failed; see skippedUids for previously skipped messages"
     : "IMAP poll failed; retry is backed off";
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
