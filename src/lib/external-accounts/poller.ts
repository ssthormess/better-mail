import { and, asc, eq, or, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, externalAccounts, mailboxes } from "@/db/schema";
import { decryptSecret } from "./crypto";
import { isSyncCursorFormat } from "./cursor";
import { fetchImap } from "./imap-client";
import { inboundStorageKey } from "@/lib/email/inbound-id";
import { processInboundMessage } from "@/lib/email/inbound";
import { readHeaderMap } from "@/lib/email/provider-trace";

const INTERVAL_MS = 60_000;
const MAX_BATCH = 50;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_TICK_MS = 25_000;
const inFlight = new Set<string>();
const failures = new Map<string, number>();

/** Runs only in the Node runtime: workerd's TCP sockets are not compatible with node:net/tls. */
export async function pollExternalImapAccounts(env: CloudflareEnv, now = new Date()) {
 if (env.MAILFLARE_RUNTIME !== "node") return { skipped: "runtime_unsupported", accounts: 0 };
 const tickStartedAt = Date.now();
 const db = getDb(env); const cutoff = new Date(now.getTime() - INTERVAL_MS);
 const rows = await db.select({ account: externalAccounts, mailbox: mailboxes, domain: domains })
  .from(externalAccounts).innerJoin(mailboxes, eq(externalAccounts.mailboxId, mailboxes.id)).innerJoin(domains, eq(mailboxes.domainId, domains.id))
  .where(and(eq(externalAccounts.enabled, true), eq(externalAccounts.protocol, "imap"), or(isNull(externalAccounts.lastSyncedAt), lt(externalAccounts.lastSyncedAt, cutoff))))
  .orderBy(asc(externalAccounts.lastSyncedAt)).limit(10);
 let completed = 0;
 for (const row of rows) {
  if (Date.now() - tickStartedAt > MAX_TICK_MS) break;
  const { account, mailbox, domain } = row;
  if (inFlight.has(account.id)) continue;
  const backoff = Math.min(30 * 60_000, INTERVAL_MS * 2 ** Math.min(failures.get(account.id) ?? 0, 5));
  if (account.lastSyncedAt && now.getTime() - account.lastSyncedAt.getTime() < backoff) continue;
  inFlight.add(account.id);
  try {
   const cursor = account.syncCursor === null ? null : isSyncCursorFormat(account.syncCursor, "imap") ? JSON.parse(account.syncCursor) as { uidValidity?: number; lastUid?: number } : null;
   const secret = await decryptSecret(env, account.passwordEncrypted);
   const result = await fetchImap({ host: account.host, port: account.port, tlsMode: account.tlsMode, username: account.username, password: secret }, cursor && Number.isInteger(cursor.uidValidity) && Number.isInteger(cursor.lastUid) ? { uidValidity: cursor.uidValidity!, lastUid: cursor.lastUid! } : null, MAX_BATCH, MAX_MESSAGE_BYTES);
   for (const item of result.messages) {
    // Content hash scoped to mailbox makes retries idempotent in the canonical inbound consumer.
    const rawBytes = new Uint8Array(item.raw.byteLength);
    rawBytes.set(item.raw);
    const rawBuffer = rawBytes.buffer;
    const rawR2Key = await inboundStorageKey(rawBuffer, mailbox.id);
    await env.BUCKET.put(rawR2Key, rawBuffer, { httpMetadata: { contentType: "message/rfc822" } });
    const headers = readHeaderMap(rawBuffer);
    await processInboundMessage(env, { from: headers.from ?? "", to: `${mailbox.localPart}@${domain.hostname}`, rawR2Key, headers });
   }
   const lastUid = result.messages.length ? result.lastUid : result.uidValidity === cursor?.uidValidity ? cursor.lastUid ?? 0 : 0;
   await db.update(externalAccounts).set({ syncCursor: JSON.stringify({ uidValidity: result.uidValidity, lastUid }), lastSyncedAt: now, lastError: null, updatedAt: now }).where(eq(externalAccounts.id, account.id));
   failures.delete(account.id); completed++;
  } catch (error) {
   const count = (failures.get(account.id) ?? 0) + 1; failures.set(account.id, count);
   // Never persist raw server output or exception text: some servers echo LOGIN credentials.
   const message = error instanceof Error && error.message === "authentication_failed" ? "Authentication failed" : error instanceof Error && error.message === "message_too_large" ? "Message exceeds the 5 MiB fetch limit" : "IMAP poll failed; retry is backed off";
   await db.update(externalAccounts).set({ lastError: message, lastSyncedAt: now, updatedAt: now }).where(eq(externalAccounts.id, account.id));
  } finally { inFlight.delete(account.id); }
 }
 return { accounts: completed };
}
