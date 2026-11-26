import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const MAX_RESPONSE = 12 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
type Socket = import("node:net").Socket;

/** Minimal IMAP4rev1 client for self-hosted Node. Responses are never included in thrown errors. */
export async function fetchImap(account: { host: string; port: number; tlsMode: string; username: string; password: string }, cursor: { uidValidity: number; lastUid: number } | null, maxMessages: number, maxBytes: number) {
 const conn: { socket?: Socket } = {};
 let data = Buffer.alloc(0);
 let nextTag = 0;
 const waiters: Array<() => void> = [];
 const connectSocket = (tls: boolean) => new Promise<Socket>((resolve, reject) => {
  const s = tls ? tlsConnect({ host: account.host, port: account.port, servername: account.host, rejectUnauthorized: true }) : tcpConnect({ host: account.host, port: account.port });
  const timer = setTimeout(() => { s.destroy(); reject(new Error("timeout")); }, TIMEOUT_MS);
  s.once("secureConnect", () => { clearTimeout(timer); resolve(s); });
  s.once("connect", () => { if (!tls) { clearTimeout(timer); resolve(s); } });
  s.once("error", () => { clearTimeout(timer); reject(new Error("connection_failed")); });
 });
 const readGreeting = async (s: Socket) => { conn.socket = s; s.on("data", chunk => { data = Buffer.concat([data, chunk]); if (data.length > MAX_RESPONSE) s.destroy(new Error("response_too_large")); for (const w of waiters.splice(0)) w(); }); s.on("error", () => { for (const w of waiters.splice(0)) w(); }); await until(() => data.includes(Buffer.from("\r\n"))); const line = takeLine(); if (!/^\* OK\b/i.test(line)) throw new Error("server_unavailable"); };
 const until = async (condition: () => boolean) => { const end = Date.now() + TIMEOUT_MS; while (!condition()) { if (Date.now() > end || !conn.socket || conn.socket.destroyed) throw new Error("connection_failed"); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); waiters.push(() => { clearTimeout(timer); resolve(); }); }); } };
 const takeLine = () => { const at = data.indexOf(Buffer.from("\r\n")); const line = data.subarray(0, at).toString("utf8"); data = data.subarray(at + 2); return line; };
 const command = async (text: string): Promise<Buffer> => {
  const s = conn.socket!; const tag = `A${++nextTag}`; s.write(`${tag} ${text}\r\n`);
  const chunks: Buffer[] = []; let total = 0;
  for (;;) {
   await until(() => data.includes(Buffer.from("\r\n")));
   const line = takeLine(); chunks.push(Buffer.from(line + "\r\n")); total += Buffer.byteLength(line) + 2;
   const literal = line.match(/\{(\d+)\}$/);
   if (literal) { const length = Number(literal[1]); if (length > maxBytes || total + length > maxBytes + 65536) throw new Error("message_too_large"); await until(() => data.length >= length); const bytes = data.subarray(0, length); data = data.subarray(length); chunks.push(Buffer.from(bytes)); total += length; }
   if (line.startsWith(`${tag} `)) { if (!line.startsWith(`${tag} OK`)) { const code = /\[AUTHENTICATIONFAILED\]/i.test(line) ? "authentication_failed" : "imap_command_failed"; throw new Error(code); } return Buffer.concat(chunks); }
  }
 };
 try {
  const initial = await connectSocket(account.tlsMode === "implicit-tls"); await readGreeting(initial);
  if (account.tlsMode === "starttls") { await command("STARTTLS"); const upgraded = await new Promise<Socket>((resolve, reject) => { const secure = tlsConnect({ socket: conn.socket!, servername: account.host, rejectUnauthorized: true }, () => resolve(secure)); secure.once("error", () => reject(new Error("tls_failed"))); }); await readGreetingAfterUpgrade(upgraded); }
  await command(`LOGIN ${quote(account.username)} ${quote(account.password)}`);
  const selected = await command('EXAMINE "INBOX"');
  const validity = Number(selected.toString().match(/\[UIDVALIDITY (\d+)\]/i)?.[1]); if (!Number.isSafeInteger(validity) || validity < 0) throw new Error("invalid_mailbox_state");
  const startUid = cursor?.uidValidity === validity ? cursor.lastUid + 1 : 1;
  const search = await command(`UID SEARCH UID ${startUid}:*`);
  const uids = [...(search.toString().match(/\* SEARCH([^\r\n]*)/)?.[1] ?? "").trim().split(/\s+/)].filter(Boolean).map(Number).filter(Number.isSafeInteger).sort((a,b)=>a-b).slice(0,maxMessages);
  const fetched: Array<{ uid: number; raw: Buffer }> = []; let maxUid = cursor?.uidValidity === validity ? cursor.lastUid : 0;
  for (const uid of uids) {
   const response = await command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
   const match = response.toString().match(/\* \d+ FETCH \(UID (\d+) BODY\[\] \{(\d+)\}\r\n/);
   if (!match) throw new Error("invalid_fetch_response");
   const marker = Buffer.from(match[0]); const offset = response.indexOf(marker) + marker.length;
   const raw = response.subarray(offset, offset + Number(match[2]));
   if (raw.length > maxBytes) throw new Error("message_too_large");
   fetched.push({ uid, raw: Buffer.from(raw) }); maxUid = uid;
  }
  await command("LOGOUT"); conn.socket?.end(); return { uidValidity: validity, lastUid: maxUid, messages: fetched };
 } catch (error) { conn.socket?.destroy(); throw error; }
 async function readGreetingAfterUpgrade(s: Socket) { conn.socket = s; data = Buffer.alloc(0); s.on("data", chunk => { data = Buffer.concat([data, chunk]); for (const w of waiters.splice(0)) w(); }); await until(() => true); }
}
function quote(value: string) { return `"${value.replace(/[\\\"]/g, "\\$&")}"`; }
