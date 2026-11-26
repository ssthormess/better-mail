import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tcpConnect } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

export const IMAP_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const IMAP_MAX_MESSAGES_PER_POLL = 50;
export const IMAP_MAX_BATCH_BYTES = 20 * 1024 * 1024;
export const IMAP_UID_SEARCH_WINDOW = 1_000;
const SESSION_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_BUFFERED_SOCKET_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_RESPONSE_METADATA_BYTES = 512 * 1024;
const MAX_SEARCH_UIDS = IMAP_UID_SEARCH_WINDOW;

type Socket = import("node:net").Socket;
type FetchedMessage = { uid: number; raw: Buffer };
type FetchEvent = (FetchedMessage | { uid: number; outcome: "oversized" | "expunged" | "scanned" }) & { uidValidity: number };
type ImapRecord = { lines: string[]; literal: Buffer | null; literalLength: number; hasLiteral: boolean; literalAttribute: string | null };
type ImapResponse = { records: ImapRecord[] };

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
 options: { maxBatchBytes?: number; deadlineAt?: number; onMessage?: (message: FetchEvent) => Promise<boolean | void> } = {},
) {
 const sessionDeadline = Math.min(Date.now() + SESSION_TIMEOUT_MS, options.deadlineAt ?? Number.POSITIVE_INFINITY);
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
 const dialAddresses = async () => {
  // Resolve afresh and dial only checked numeric results, closing the DNS-rebind gap.
  const addresses = isIP(account.host) ? [{ address: account.host }] : await withDeadline(lookup(account.host, { all: true, verbatim: true }), Math.min(sessionDeadline, Date.now() + COMMAND_TIMEOUT_MS));
  if (!addresses.length) throw new Error("connection_failed");
  if (!account.allowPrivate && addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("egress_denied");
  return [...new Set(addresses.map(({ address }) => address))].slice(0, 8);
 };
 const establish = async (mode: "plain" | "implicit-tls") => {
  const addresses = await dialAddresses();
  let lastError: unknown = new Error("connection_failed");
  for (const address of addresses) {
   if (Date.now() >= sessionDeadline) throw new Error("timeout");
   let candidate: Socket | undefined;
   try {
    if (mode === "plain") {
     const plain = tcpConnect({ host: address, port: account.port });
     candidate = plain;
     await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { plain.destroy(); reject(new Error("timeout")); }, Math.min(COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
      plain.once("connect", () => { clearTimeout(timer); resolve(); });
      plain.once("error", () => { clearTimeout(timer); reject(new Error("connection_failed")); });
     });
     attach(plain);
    } else {
     const secure = tlsConnect({ host: address, port: account.port, ...(isIP(account.host) ? {} : { servername: account.host }), rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(account.host, cert) });
     candidate = secure;
     await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { secure.destroy(); reject(new Error("timeout")); }, Math.min(COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
      secure.once("secureConnect", () => { clearTimeout(timer); resolve(); });
      secure.once("error", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
      secure.once("end", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
      secure.once("close", () => { if (!secure.authorized) { clearTimeout(timer); reject(new Error("tls_failed")); } });
     });
     attach(secure);
    }
    await readGreeting();
    if (account.tlsMode === "starttls") {
     await command("STARTTLS", 0);
     const plain = socket!;
     plain.removeAllListeners("data"); plain.removeAllListeners("error"); plain.removeAllListeners("end"); plain.removeAllListeners("close");
     receive.length = 0; bufferedBytes = 0; closed = false;
     const secure = tlsConnect({ socket: plain, ...(isIP(account.host) ? {} : { servername: account.host }), rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(account.host, cert) });
     candidate = secure;
     await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { secure.destroy(); reject(new Error("timeout")); }, Math.min(COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
      secure.once("secureConnect", () => { clearTimeout(timer); resolve(); });
      secure.once("error", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
      secure.once("end", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
      secure.once("close", () => { if (!secure.authorized) { clearTimeout(timer); reject(new Error("tls_failed")); } });
     });
     attach(secure);
    }
    return;
   } catch (error) {
    lastError = error;
    candidate?.removeAllListeners("data"); candidate?.removeAllListeners("error"); candidate?.removeAllListeners("end"); candidate?.removeAllListeners("close");
    candidate?.destroy();
    if (socket === candidate) socket = undefined;
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = undefined; receive.length = 0; bufferedBytes = 0; closed = false; responseMetadataBytes = 0;
    if (Date.now() >= sessionDeadline) throw new Error("timeout");
   }
  }
  throw lastError instanceof Error ? lastError : new Error("connection_failed");
 };
 const readGreeting = async () => {
  const line = await readLine(Math.min(sessionDeadline, Date.now() + COMMAND_TIMEOUT_MS));
  if (!/^\* (?:OK|PREAUTH)(?: |$)/i.test(line) || /^\* PREAUTH(?: |$)/i.test(line)) throw new Error("server_unavailable");
 };
 const command = async (text: string, literalLimit = maxBytes): Promise<ImapResponse> => {
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
    if (tagged[1].toUpperCase() !== "OK") throw new Error(/\[AUTHENTICATIONFAILED\]/i.test(line) ? "authentication_failed" : "imap_command_failed");
    return { records };
   }
   if (/^[A-Za-z]\d+ /.test(line)) throw new Error("invalid_response");
   if (line.startsWith("+")) throw new Error("unsupported_continuation");
   if (line.startsWith("* ")) {
    if (current && isFetchRecord(current)) validateFetchRecord(current);
    current = { lines: [line], literal: null, literalLength: 0, hasLiteral: false, literalAttribute: null };
    records.push(current);
   } else if (current) current.lines.push(line);
   else throw new Error("invalid_response");

   const tokens = current ? recordTokens(current) : [];
   const marker = line.match(/\{(0|[1-9]\d*)\+?\}$/);
   if (marker) {
    if (!current || !isFetchRecord(current) || current.hasLiteral) throw new Error("invalid_literal");
    const literalAttr = parseFetchAttributes(current, true).find(attribute => attribute.valueIndex === tokens.length - 1);
    if (!literalAttr || !["BODY[]", "RFC822"].includes(literalAttr.name.toUpperCase())) throw new Error("invalid_literal");
    const length = Number(marker[1]);
    if (!Number.isSafeInteger(length)) throw new Error("response_limit");
    current.hasLiteral = true;
    current.literalLength = length;
    current.literalAttribute = literalAttr.name.toUpperCase();
    if (length > literalLimit) throw new Error("message_size_unverified");
    current.literal = await readBytes(length, deadline) ?? Buffer.alloc(0);
   }
  }
 };
 let tagNumber = 0;
 const initialCursor = cursor;
 const maxBatchBytes = options.maxBatchBytes ?? IMAP_MAX_BATCH_BYTES;
 const callback = options.onMessage;
 const deliver = async (event: FetchEvent) => {
  const result = callback ? await callback(event) : undefined;
  if (Date.now() >= sessionDeadline) throw new Error("timeout");
  return result !== false;
 };
 const uidExists = async (uid: number) => {
  const response = await command(`UID SEARCH UID ${uid}:${uid}`, 0);
  return extractSearchUids(response, uid, uid).includes(uid);
 };
 let currentValidity: number | null = null;
 let lastUid = cursor?.lastUid ?? 0;
 let batchBytes = 0;
 let delivered = 0;
 const messages: FetchedMessage[] = [];
 const skippedUids: number[] = [];
 try {
  await establish(account.tlsMode === "implicit-tls" ? "implicit-tls" : "plain");
  if (!isSafeLoginArgument(account.username) || !isSafeLoginArgument(account.password)) throw new Error("credentials_unsupported");
  await command(`LOGIN ${quote(account.username)} ${quote(account.password)}`, 0);
  const selected = await command('EXAMINE "INBOX"', 0);
  const validityText = extractResponseCode(selected, "UIDVALIDITY");
  const uidNextText = extractResponseCode(selected, "UIDNEXT");
  const validity = Number(validityText);
  const uidNext = Number(uidNextText);
  if (!validityText || !/^[1-9]\d*$/.test(validityText) || !Number.isSafeInteger(validity) || validity > 0xffff_ffff
   || !uidNextText || !/^[1-9]\d*$/.test(uidNextText) || !Number.isSafeInteger(uidNext) || uidNext > 0xffff_ffff) throw new Error("invalid_mailbox_state");
  currentValidity = validity;
  const startUid = cursor?.uidValidity === validity ? cursor.lastUid + 1 : 1;
  if (cursor?.uidValidity !== validity) lastUid = 0;
  if (startUid <= 0xffff_ffff && startUid < uidNext) {
   const endUid = Math.min(0xffff_ffff, startUid + IMAP_UID_SEARCH_WINDOW - 1, uidNext - 1);
   const search = await command(`UID SEARCH UID ${startUid}:${endUid}`, 0);
   const uids = extractSearchUids(search, startUid, endUid);
   let fullyProcessed = true;
   for (const uid of uids.slice(0, maxMessages)) {
    if (Date.now() >= sessionDeadline) throw new Error("timeout");
    const sizeResponse = await command(`UID FETCH ${uid} (UID RFC822.SIZE)`, 0);
    const sizeRecord = findFetchRecord(sizeResponse, uid, "RFC822.SIZE");
    if (!sizeRecord) {
     if (await uidExists(uid)) throw new Error("unexpected_fetch_response");
     if (!await deliver({ uid, outcome: "expunged", uidValidity: validity })) { fullyProcessed = false; break; }
     lastUid = Math.max(lastUid, uid);
     continue;
    }
    const size = extractFetchNumber(sizeRecord, "RFC822.SIZE");
    if (size === null) throw new Error("invalid_fetch_response");
    if (size > maxBytes) {
     if (!await deliver({ uid, outcome: "oversized", uidValidity: validity })) { fullyProcessed = false; break; }
     skippedUids.push(uid); delivered++; lastUid = Math.max(lastUid, uid);
     continue;
    }
    const bodyResponse = await command(`UID FETCH ${uid} (UID BODY.PEEK[])`, maxBytes);
    const bodyRecord = findFetchRecord(bodyResponse, uid, "BODY[]", "RFC822");
    if (!bodyRecord) {
     if (await uidExists(uid)) throw new Error("unexpected_fetch_response");
     if (!await deliver({ uid, outcome: "expunged", uidValidity: validity })) { fullyProcessed = false; break; }
     lastUid = Math.max(lastUid, uid);
     continue;
    }
    if (!bodyRecord.hasLiteral || bodyRecord.literal === null) throw new Error("invalid_fetch_response");
    if (bodyRecord.literalLength > maxBytes) throw new Error("message_size_unverified");
    if (bodyRecord.literalLength !== size) throw new Error("body_size_mismatch");
    const event = { uid, raw: bodyRecord.literal, uidValidity: validity };
    if (event.raw.byteLength + batchBytes > maxBatchBytes) { fullyProcessed = false; break; }
    if (!await deliver(event)) { fullyProcessed = false; break; }
    batchBytes += event.raw.byteLength; delivered++; lastUid = Math.max(lastUid, uid);
    if (!callback) messages.push(event);
   }
   if (fullyProcessed && uids.length < maxMessages) {
    await deliver({ uid: endUid, outcome: "scanned", uidValidity: validity });
    lastUid = Math.max(lastUid, endUid);
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

function isFetchRecord(record: ImapRecord) { return /^\* [1-9]\d* FETCH \(/i.test(record.lines[0] ?? ""); }
function recordTokens(record: ImapRecord): string[] {
 const text = record.lines.join(" "); const tokens: string[] = [];
 for (let i = 0; i < text.length;) {
  if (/\s/.test(text[i])) { i++; continue; }
  if (text[i] === "(" || text[i] === ")") { tokens.push(text[i++]); continue; }
  if (text[i] === '"') {
   let j = i + 1;
   while (j < text.length) { if (text[j] === "\\") { j += 2; continue; } if (text[j++] === '"') break; }
   if (j > text.length || text[j - 1] !== '"') throw new Error("invalid_fetch_response");
   tokens.push("<quoted>"); i = j; continue;
  }
  let j = i + 1;
  while (j < text.length && !/[\s()]/.test(text[j])) j++;
  tokens.push(text.slice(i, j)); i = j;
 }
 return tokens;
}
type FetchAttribute = { name: string; value: string; valueIndex: number };
function parseFetchAttributes(record: ImapRecord, allowIncomplete = false): FetchAttribute[] {
 const tokens = recordTokens(record);
 if (!isFetchRecord(record) || tokens[3] !== "(") throw new Error("invalid_fetch_response");
 const attributes: FetchAttribute[] = [];
 const names = new Set<string>();
 let index = 4;
 while (index < tokens.length) {
  if (tokens[index] === ")") {
   if (index !== tokens.length - 1) throw new Error("invalid_fetch_response");
   return attributes;
  }
  const name = tokens[index++];
  if (!name || name === "(" || name === ")" || /^\{\d+\+?\}$/.test(name)) throw new Error("invalid_fetch_response");
  const key = name.toUpperCase();
  if (names.has(key)) throw new Error("invalid_fetch_response");
  names.add(key);
  if (index >= tokens.length || tokens[index] === ")") {
   if (allowIncomplete && index === tokens.length) return attributes;
   throw new Error("invalid_fetch_response");
  }
  const valueIndex = index;
  if (tokens[index] === "(") {
   let depth = 0;
   do {
    const token = tokens[index++];
    if (token === "(") depth++;
    else if (token === ")") depth--;
   } while (index < tokens.length && depth > 0);
   if (depth !== 0) {
    if (allowIncomplete) return attributes;
    throw new Error("invalid_fetch_response");
   }
  } else index++;
  attributes.push({ name, value: tokens[valueIndex], valueIndex });
 }
 if (!allowIncomplete) throw new Error("invalid_fetch_response");
 return attributes;
}
function validateFetchRecord(record: ImapRecord) {
 const attributes = parseFetchAttributes(record);
 if (record.hasLiteral !== (record.literal !== null)) throw new Error("invalid_fetch_response");
 if (record.hasLiteral) {
  const marker = recordTokens(record).map((token, index) => ({ token, index })).filter(({ token }) => new RegExp(`^\\{${record.literalLength}\\+?\\}$`).test(token));
  const attached = attributes.filter(attribute => marker.some(item => item.index === attribute.valueIndex));
  if (attached.length !== 1 || attached[0].name.toUpperCase() !== record.literalAttribute) throw new Error("invalid_fetch_response");
 } else if (record.literalAttribute !== null) throw new Error("invalid_fetch_response");
}
function attributeValue(record: ImapRecord, name: string): string | null {
 const attributes = parseFetchAttributes(record).filter(attribute => attribute.name.toUpperCase() === name.toUpperCase());
 if (attributes.length > 1) throw new Error("invalid_fetch_response");
 return attributes[0]?.value ?? null;
}
function extractFetchUid(record: ImapRecord): number | null {
 const value = attributeValue(record, "UID");
 if (!value || !/^[1-9]\d*$/.test(value)) return null;
 const uid = Number(value);
 return Number.isSafeInteger(uid) && uid <= 0xffff_ffff ? uid : null;
}
function extractResponseCode(response: ImapResponse, name: "UIDVALIDITY" | "UIDNEXT"): string | null {
 for (const record of response.records) {
  const first = record.lines[0] ?? "";
  const match = first.match(/^\* OK \[([A-Z]+) ([0-9]+)\]/i);
  if (match?.[1].toUpperCase() === name) return match[2];
 }
 return null;
}
function findFetchRecord(response: ImapResponse, uid: number, ...attributes: string[]): ImapRecord | null {
 const wanted = new Set(attributes.map(attribute => attribute.toUpperCase()));
 const matching = response.records.filter(record => {
  if (!isFetchRecord(record) || extractFetchUid(record) !== uid) return false;
  const pairs = parseFetchAttributes(record);
  const requested = pairs.filter(attribute => wanted.has(attribute.name.toUpperCase()));
  if (!requested.length) return false;
  return !record.hasLiteral || requested.some(attribute => attribute.name.toUpperCase() === record.literalAttribute && attribute.valueIndex >= 0);
 });
 if (matching.length > 1) throw new Error("invalid_fetch_response");
 return matching[0] ?? null;
}
function extractFetchNumber(record: ImapRecord, attribute: string): number | null {
 const value = attributeValue(record, attribute);
 if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
 const result = Number(value);
 return Number.isSafeInteger(result) ? result : null;
}
function extractSearchUids(response: ImapResponse, startUid: number, endUid: number): number[] {
 const lines = response.records.filter(record => /^\* SEARCH(?: |$)/i.test(record.lines[0] ?? ""));
 if (lines.length !== 1 || lines[0].lines.length !== 1) throw new Error("invalid_search_response");
 const tokens = lines[0].lines[0].slice(8).trim().split(/\s+/).filter(Boolean);
 if (tokens.length > MAX_SEARCH_UIDS) throw new Error("search_limit");
 const uids: number[] = [];
 for (const token of tokens) {
  if (!/^[1-9]\d*$/.test(token)) throw new Error("invalid_search_response");
  const uid = Number(token);
  if (!Number.isSafeInteger(uid) || uid > 0xffff_ffff || uid < startUid || uid > endUid) throw new Error("invalid_search_response");
  if (uids.includes(uid)) throw new Error("invalid_search_response");
  uids.push(uid);
 }
 return uids.sort((a, b) => a - b);
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
