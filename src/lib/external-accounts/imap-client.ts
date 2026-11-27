import { createFetchTransport, EXTERNAL_COMMAND_TIMEOUT_MS, EXTERNAL_SESSION_TIMEOUT_MS, isSafeLoginArgument, quote } from "./transport";

export const IMAP_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const IMAP_MAX_MESSAGES_PER_POLL = 50;
export const IMAP_MAX_BATCH_BYTES = 20 * 1024 * 1024;
export const IMAP_UID_SEARCH_WINDOW = 1_000;
const SESSION_TIMEOUT_MS = EXTERNAL_SESSION_TIMEOUT_MS;
const COMMAND_TIMEOUT_MS = EXTERNAL_COMMAND_TIMEOUT_MS;
const MAX_SEARCH_UIDS = IMAP_UID_SEARCH_WINDOW;

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
 const transport = createFetchTransport(account, sessionDeadline);
 const readGreeting = async (readLine: (deadline: number) => Promise<string>, deadline: number) => {
  const line = await readLine(deadline);
  if (!/^\* (?:OK|PREAUTH)(?: |$)/i.test(line) || /^\* PREAUTH(?: |$)/i.test(line)) throw new Error("server_unavailable");
 };
 const command = async (text: string, literalLimit = maxBytes): Promise<ImapResponse> => {
  if (Date.now() >= sessionDeadline) throw new Error("timeout");
  transport.resetResponseMetadata();
  const tag = `A${++tagNumber}`;
  transport.write(`${tag} ${text}\r\n`);
  const deadline = Math.min(sessionDeadline, Date.now() + COMMAND_TIMEOUT_MS);
  const records: ImapRecord[] = [];
  let current: ImapRecord | null = null;
  for (;;) {
   const line = await transport.readLine(deadline);
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
    current.literal = await transport.readBytes(length, deadline) ?? Buffer.alloc(0);
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
  await transport.connect(account.tlsMode === "implicit-tls" ? "implicit-tls" : "plain", {
   greeting: readGreeting,
   starttls: account.tlsMode === "starttls" ? async () => { await command("STARTTLS", 0); } : undefined,
  });
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
  transport.end();
  return { uidValidity: currentValidity, lastUid: Math.max(initialCursor?.uidValidity === currentValidity ? initialCursor.lastUid : 0, lastUid), messages, delivered, skippedUids };
 } catch (error) {
  transport.destroy();
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
