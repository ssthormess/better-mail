import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tcpConnect } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

export const IMAP_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const IMAP_MAX_MESSAGES_PER_POLL = 50;
export const IMAP_MAX_BATCH_BYTES = 20 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_BUFFERED_SOCKET_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_RESPONSE_METADATA_BYTES = 512 * 1024;
const MAX_SEARCH_UIDS = 65_536;

type Socket = import("node:net").Socket;
type FetchedMessage = { uid: number; raw: Buffer };
type FetchEvent = (FetchedMessage | { uid: number; skipped: "oversized" }) & { uidValidity: number };
type ImapRecord = { lines: string[]; literal: Buffer | null; literalLength: number; oversized: boolean };
type ImapResponse = { records: ImapRecord[] };
class OversizedLiteralError extends Error {
 constructor(readonly uid: number) { super("oversized_literal"); }
}

/**
 * Minimal RFC 3501 client for the Node runtime. Every command reads framed response records: literal octets
 * are consumed by declared length and never interpreted as protocol metadata. Errors intentionally omit wire
 * text, credentials and server responses.
 */
export async function fetchImap(
 account: { host: string; port: number; tlsMode: string; username: string; password: string; allowPrivate?: boolean },
 cursor: { uidValidity: number; lastUid: number } | null,
 maxMessages = IMAP_MAX_MESSAGES_PER_POLL,
 maxBytes = IMAP_MAX_MESSAGE_BYTES,
 options: { maxBatchBytes?: number; onMessage?: (message: FetchEvent) => Promise<boolean | void> } = {},
) {
 const sessionDeadline = Date.now() + SESSION_TIMEOUT_MS;
 let socket: Socket | undefined;
 const receive: Buffer[] = [];
 let bufferedBytes = 0;
 let closed = false;
 const waiters = new Set<() => void>();
 let responseMetadataBytes = 0;
 let sessionTimer: ReturnType<typeof setTimeout> | undefined;
 const wake = () => { for (const waiter of waiters) waiter(); waiters.clear(); };
 const onClosed = () => { closed = true; if (sessionTimer) clearTimeout(sessionTimer); wake(); };
 const checkDeadline = (deadline: number) => {
  if (Date.now() >= deadline) throw new Error("timeout");
  if (closed || !socket || socket.destroyed) throw new Error("connection_failed");
 };
 const waitForData = async (deadline: number) => {
  checkDeadline(deadline);
  if (bufferedBytes > 0) return;
  await new Promise<void>((resolve, reject) => {
   const remaining = Math.max(1, deadline - Date.now());
   const timer = setTimeout(() => { waiters.delete(onData); socket?.destroy(); reject(new Error("timeout")); }, remaining);
   const onData = () => { clearTimeout(timer); waiters.delete(onData); resolve(); };
   waiters.add(onData);
  });
  checkDeadline(deadline);
 };
 const readBytes = async (length: number, deadline: number, collect = true): Promise<Buffer | null> => {
  const pieces: Buffer[] = [];
  let remaining = length;
  while (remaining > 0) {
   if (!bufferedBytes) await waitForData(deadline);
   const chunk = receive[0];
   const take = Math.min(remaining, chunk.length);
   if (collect) pieces.push(chunk.subarray(0, take));
   remaining -= take; bufferedBytes -= take;
   if (take === chunk.length) receive.shift();
   else receive[0] = chunk.subarray(take);
  }
  return collect ? Buffer.concat(pieces, length) : null;
 };
 const readLine = async (deadline: number): Promise<string> => {
  const pieces: Buffer[] = [];
  let length = 0;
  for (;;) {
   if (!bufferedBytes) await waitForData(deadline);
   const chunk = receive[0];
   const newline = chunk.indexOf(10);
   const take = newline >= 0 ? newline + 1 : chunk.length;
   length += take;
   if (length > MAX_LINE_BYTES) throw new Error("response_limit");
   pieces.push(chunk.subarray(0, take)); bufferedBytes -= take;
   if (take === chunk.length) receive.shift();
   else receive[0] = chunk.subarray(take);
   if (newline >= 0) {
    const line = Buffer.concat(pieces, length).toString("ascii");
    if (!line.endsWith("\r\n")) throw new Error("invalid_response");
    responseMetadataBytes += length;
    if (responseMetadataBytes > MAX_RESPONSE_METADATA_BYTES) throw new Error("response_limit");
    return line.slice(0, -2);
   }
  }
 };
 const attach = (next: Socket) => {
  if (sessionTimer) clearTimeout(sessionTimer);
  socket = next; closed = false;
  sessionTimer = setTimeout(() => next.destroy(), Math.max(1, sessionDeadline - Date.now()));
  next.on("data", (chunk: Buffer) => {
   if (bufferedBytes + chunk.length > MAX_BUFFERED_SOCKET_BYTES) { next.destroy(); closed = true; wake(); return; }
   receive.push(chunk); bufferedBytes += chunk.length; wake();
  });
  next.on("error", onClosed); next.on("end", onClosed); next.on("close", onClosed);
 };
 const dialAddress = async () => {
  // Resolve afresh for every connection and dial one of the checked numeric results, closing the DNS-rebind gap.
  const addresses = isIP(account.host) ? [{ address: account.host }] : await withDeadline(lookup(account.host, { all: true, verbatim: true }), Math.min(sessionDeadline, Date.now() + COMMAND_TIMEOUT_MS));
  if (!addresses.length) throw new Error("connection_failed");
  if (!account.allowPrivate && addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("egress_denied");
  return addresses[0].address;
 };
 const establish = async (mode: "plain" | "implicit-tls" | "starttls") => {
  const address = await dialAddress();
  const tlsOptions = { host: address, port: account.port, ...(isIP(account.host) ? {} : { servername: account.host }), rejectUnauthorized: true as const, checkServerIdentity: (_host: string, cert: import("node:tls").PeerCertificate) => checkServerIdentity(account.host, cert) };
  if (mode === "plain") {
   const plain = tcpConnect({ host: address, port: account.port });
   await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { plain.destroy(); reject(new Error("timeout")); }, Math.min(COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
    plain.once("connect", () => { clearTimeout(timer); resolve(); });
    plain.once("error", () => { clearTimeout(timer); reject(new Error("connection_failed")); });
   });
   attach(plain); return;
  }
  const secure = tlsConnect(tlsOptions);
  await new Promise<void>((resolve, reject) => {
   const timer = setTimeout(() => { secure.destroy(); reject(new Error("timeout")); }, Math.min(COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
   const done = () => { clearTimeout(timer); resolve(); };
   secure.once("secureConnect", done);
   secure.once("error", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
   secure.once("end", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
   secure.once("close", () => { if (!secure.authorized) { clearTimeout(timer); reject(new Error("tls_failed")); } });
  });
  attach(secure);
 };
 const readGreeting = async () => {
  const line = await readLine(Math.min(sessionDeadline, Date.now() + COMMAND_TIMEOUT_MS));
  if (!/^\* (?:OK|PREAUTH)(?: |$)/i.test(line) || /^\* PREAUTH(?: |$)/i.test(line)) throw new Error("server_unavailable");
 };
 const command = async (text: string, literalLimit = maxBytes, oversizedUid?: number): Promise<ImapResponse> => {
  if (Date.now() >= sessionDeadline) throw new Error("timeout");
  responseMetadataBytes = 0;
  const s = socket!;
  const tag = `A${++tagNumber}`;
  s.write(`${tag} ${text}\r\n`);
  const deadline = Math.min(sessionDeadline, Date.now() + COMMAND_TIMEOUT_MS);
  const records: ImapRecord[] = [];
  let current: ImapRecord | null = null;
  for (;;) {
   const line = await readLine(deadline);
   const tagged = line.match(new RegExp(`^${tag} (OK|NO|BAD)(?: |$)`, "i"));
   if (tagged) {
    if (current && isFetchRecord(current)) validateFetchRecord(current);
    if (tagged[1].toUpperCase() !== "OK") {
     throw new Error(/\[AUTHENTICATIONFAILED\]/i.test(line) ? "authentication_failed" : "imap_command_failed");
    }
    return { records };
   }
   if (/^[A-Za-z]\d+ /.test(line)) throw new Error("invalid_response");
   if (line.startsWith("+")) throw new Error("unsupported_continuation");
   if (line.startsWith("* ")) {
    if (current && isFetchRecord(current)) validateFetchRecord(current);
    current = { lines: [line], literal: null, literalLength: 0, oversized: false };
    records.push(current);
   } else if (current) current.lines.push(line);
   else throw new Error("invalid_response");

   const literalMarker = line.match(/\{(0|[1-9]\d*)\+?\}$/);
   if (literalMarker) {
    if (!current || !isFetchRecord(current) || current.literalLength !== 0) throw new Error("invalid_literal");
    const length = Number(literalMarker[1]);
    if (!Number.isSafeInteger(length)) throw new Error("response_limit");
    current.literalLength = length;
    if (length > literalLimit) {
     current.oversized = true;
     if (oversizedUid !== undefined && isFetchRecord(current)) throw new OversizedLiteralError(oversizedUid);
     await readBytes(length, deadline, false);
    } else current.literal = await readBytes(length, deadline);
   }
  }
 };
 let tagNumber = 0;
 const initialCursor = cursor;
 const maxBatchBytes = options.maxBatchBytes ?? IMAP_MAX_BATCH_BYTES;
 const callback = options.onMessage;
 let currentValidity: number | null = null;
 let lastUid = cursor?.lastUid ?? 0;
 let batchBytes = 0;
 let delivered = 0;
 const messages: FetchedMessage[] = [];
 const skippedUids: number[] = [];
 try {
  await establish(account.tlsMode === "implicit-tls" ? "implicit-tls" : "plain");
  await readGreeting();
  if (account.tlsMode === "starttls") {
   await command("STARTTLS", 0);
   const plain = socket!;
   plain.removeAllListeners("data"); plain.removeAllListeners("error"); plain.removeAllListeners("end"); plain.removeAllListeners("close");
   receive.length = 0; bufferedBytes = 0; closed = false;
   const secure = tlsConnect({ socket: plain, ...(isIP(account.host) ? {} : { servername: account.host }), rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(account.host, cert) });
   await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { secure.destroy(); reject(new Error("timeout")); }, Math.min(COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
    secure.once("secureConnect", () => { clearTimeout(timer); resolve(); });
    secure.once("error", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
    secure.once("end", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
    secure.once("close", () => { if (!secure.authorized) { clearTimeout(timer); reject(new Error("tls_failed")); } });
   });
   attach(secure);
  }
  if (!isSafeLoginArgument(account.username) || !isSafeLoginArgument(account.password)) throw new Error("credentials_unsupported");
  await command(`LOGIN ${quote(account.username)} ${quote(account.password)}`, 0);
  const selected = await command('EXAMINE "INBOX"', 0);
  const validityText = extractUidValidity(selected);
  const validity = Number(validityText);
  if (!validityText || !/^[1-9]\d*$/.test(validityText) || !Number.isSafeInteger(validity) || validity > 0xffff_ffff) throw new Error("invalid_mailbox_state");
  currentValidity = validity;
  const startUid = cursor?.uidValidity === validity ? cursor.lastUid + 1 : 1;
  if (startUid <= 0xffff_ffff) {
   const search = await command(`UID SEARCH UID ${startUid}:*`, 0);
   const uids = extractSearchUids(search, startUid, maxMessages);
   for (const uid of uids) {
    if (Date.now() >= sessionDeadline) throw new Error("timeout");
    let response: ImapResponse;
    try { response = await command(`UID FETCH ${uid} (UID BODY.PEEK[])`, maxBytes, uid); }
    catch (error) {
     if (!(error instanceof OversizedLiteralError)) throw error;
     if (callback) await withDeadline(Promise.resolve(callback({ uid, skipped: "oversized", uidValidity: validity })), sessionDeadline);
     skippedUids.push(uid); delivered++; lastUid = Math.max(lastUid, uid);
     if (sessionTimer) clearTimeout(sessionTimer);
     socket?.destroy();
     return { uidValidity: validity, lastUid: Math.max(initialCursor?.uidValidity === validity ? initialCursor.lastUid : 0, lastUid), messages, delivered, skippedUids, stoppedAfterOversized: true };
    }
    const fetchRecords = response.records.filter(isFetchRecord);
    // Expunges between SEARCH and FETCH are normal; ignore the vanished UID and continue.
    if (!fetchRecords.length) continue;
    if (fetchRecords.length !== 1) throw new Error("invalid_fetch_response");
    const record = fetchRecords[0];
    validateFetchRecord(record);
    const recordMetadata = record.lines.join(" ");
    if (extractFetchUid(record) !== uid || !/(?:BODY\[\]|RFC822)/i.test(recordMetadata)) throw new Error("invalid_fetch_response");
    if (record.oversized) {
     const keepGoing = await (callback ? withDeadline(Promise.resolve(callback({ uid, skipped: "oversized", uidValidity: validity })), sessionDeadline) : undefined);
     skippedUids.push(uid); delivered++; lastUid = Math.max(lastUid, uid);
     if (keepGoing === false) break;
     continue;
    }
    if (!record.literal) throw new Error("invalid_fetch_response");
    const event = { uid, raw: record.literal, uidValidity: validity };
    if (event.raw.byteLength + batchBytes > maxBatchBytes) break;
    const keepGoing = await (callback ? withDeadline(Promise.resolve(callback(event)), sessionDeadline) : undefined);
    batchBytes += event.raw.byteLength; delivered++; lastUid = Math.max(lastUid, uid);
    if (!callback) messages.push(event);
    if (keepGoing === false) break;
   }
  }
  await command("LOGOUT", 0).catch(() => {});
  if (sessionTimer) clearTimeout(sessionTimer);
  socket?.end();
  return { uidValidity: currentValidity, lastUid: Math.max(initialCursor?.uidValidity === currentValidity ? initialCursor.lastUid : 0, lastUid), messages, delivered, skippedUids };
 } catch (error) {
  if (sessionTimer) clearTimeout(sessionTimer);
  socket?.destroy();
  throw error;
 }
}

function isFetchRecord(record: ImapRecord) { return /^\* \d+ FETCH \(/i.test(record.lines[0] ?? ""); }
function validateFetchRecord(record: ImapRecord) {
 if (!record.lines.at(-1)?.endsWith(")") || record.literalLength > 0 && record.literal === null && !record.oversized) throw new Error("invalid_fetch_response");
}
function extractFetchUid(record: ImapRecord) {
 const metadata = record.lines.join(" ");
 const value = metadata.match(/\bUID (0|[1-9]\d*)\b/i)?.[1];
 if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
 const uid = Number(value);
 return Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffff_ffff ? uid : null;
}
function extractUidValidity(response: ImapResponse): string | null {
 for (const record of response.records) {
  const first = record.lines[0] ?? "";
  if (/^\* OK(?: |$)/i.test(first)) {
   const value = first.match(/\[UIDVALIDITY ([^\]\s]+)\]/i)?.[1];
   if (value) return value;
  }
 }
 return null;
}
function extractSearchUids(response: ImapResponse, startUid: number, maxMessages: number): number[] {
 const lines = response.records.filter(record => /^\* SEARCH(?: |$)/i.test(record.lines[0] ?? ""));
 if (lines.length !== 1 || lines[0].lines.length !== 1) throw new Error("invalid_search_response");
 const tokens = lines[0].lines[0].slice(8).trim().split(/\s+/).filter(Boolean);
 if (tokens.length > MAX_SEARCH_UIDS) throw new Error("search_limit");
 const ordered: number[] = [];
 for (const token of tokens) {
  if (!/^[1-9]\d*$/.test(token)) throw new Error("invalid_search_response");
  const uid = Number(token);
  if (!Number.isSafeInteger(uid) || uid > 0xffff_ffff) throw new Error("invalid_search_response");
  if (uid < startUid) continue; // Dovecot and RFC sequence-set semantics can return lower UIDs for `N:*`.
  let at = ordered.findIndex(value => value > uid);
  if (at < 0) at = ordered.length;
  ordered.splice(at, 0, uid);
  if (ordered.length > maxMessages) ordered.pop();
 }
 return [...new Set(ordered)];
}
async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, deadline - Date.now())); })]);
 } finally { if (timer) clearTimeout(timer); }
}
function isSafeLoginArgument(value: string) { return /^[\x20-\x7e]+$/.test(value) && !/[\r\n\0]/.test(value); }
function quote(value: string) { return `"${value.replace(/[\\"]/g, "\\$&")}"`; }

function isPublicAddress(address: string): boolean {
 if (isIP(address) === 4) {
  const parts = address.split(".").map(Number);
  const n = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  const ranges: Array<[number, number]> = [
   [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
   [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16],
   [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ];
  return !ranges.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
 }
 if (isIP(address) !== 6) return false;
 const value = ipv6Number(address);
 const inRange = (base: bigint, bits: number) => value >> BigInt(128 - bits) === base >> BigInt(128 - bits);
 // Only global unicast is routable by default; exclude documentation, protocol-assignment and transition blocks.
 return inRange(0x20000000000000000000000000000000n, 3)
  && !inRange(0x20010db8000000000000000000000000n, 32)
  && !inRange(0x20010000000000000000000000000000n, 23)
  && !inRange(0x20020000000000000000000000000000n, 16)
  && !inRange(0x3fff0000000000000000000000000000n, 20);
}
function ipv6Number(address: string): bigint {
 if (address.includes(".")) return 0n;
 const halves = address.toLowerCase().split("::");
 const parse = (part: string) => part ? part.split(":").map(piece => BigInt(`0x${piece || "0"}`)) : [];
 const left = parse(halves[0]); const right = parse(halves[1] ?? "");
 const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill(0n), ...right];
 return words.reduce((value, word) => (value << 16n) | word, 0n);
}
