import { pop3UidlHash } from "./cursor";
import { IMAP_MAX_BATCH_BYTES, IMAP_MAX_MESSAGE_BYTES, IMAP_MAX_MESSAGES_PER_POLL } from "./imap-client";
import { createFetchTransport, EXTERNAL_COMMAND_TIMEOUT_MS, EXTERNAL_SESSION_TIMEOUT_MS, isSafeLoginArgument } from "./transport";

export const POP3_MAX_MESSAGE_BYTES = IMAP_MAX_MESSAGE_BYTES;
export const POP3_MAX_MESSAGES_PER_POLL = IMAP_MAX_MESSAGES_PER_POLL;
export const POP3_MAX_BATCH_BYTES = IMAP_MAX_BATCH_BYTES;
/**
 * A UIDL response is read line by line and diffed in place, so memory stays O(cursor) rather than O(mailbox);
 * this is the bound on the listing itself. A mailbox beyond it is failed closed rather than read unbounded.
 */
export const POP3_MAX_LIST_ENTRIES = 100_000;
/**
 * Wire bytes of one RETR can exceed the stored size by the dot-stuffing overhead (any line already starting
 * with "." is doubled). The reader is still bounded: stuffing can at most double the bytes, plus slack.
 */
const MAX_RETR_WIRE_OVERHEAD = (limit: number) => limit * 2 + 4 * 1024;
const MULTILINE_TERMINATOR = Buffer.from("\r\n.\r\n");

type Pop3FetchEvent = { msgnum: number; uidlHash: string } & ({ raw: Buffer } | { outcome: "oversized" });

/**
 * Minimal RFC 1939 client for the Node runtime over the shared fetch transport (dial guard, verified TLS,
 * bounded readers). New mail is defined by the UIDL list: a message is fetched when its hashed UIDL is absent
 * from both the imported (`seen`) and permanently skipped (`skipped`) sets. There is no UIDVALIDITY and no
 * folder state; the cursor the caller persists is the hash list itself.
 *
 * A server without UIDL support fails closed (`uidl_unsupported`) instead of falling back to TOP-based
 * hashing, which duplicates poorly. Mail is left on the server: DELE is never issued, so other clients and
 * the provider keep their copy. Errors intentionally omit wire text, credentials and server responses.
 */
export async function fetchPop3(
	account: { host: string; port: number; tlsMode: string; username: string; password: string; allowPrivate?: boolean },
	seen: ReadonlySet<string>,
	skipped: ReadonlySet<string>,
	maxMessages = POP3_MAX_MESSAGES_PER_POLL,
	maxBytes = POP3_MAX_MESSAGE_BYTES,
	options: { maxBatchBytes?: number; deadlineAt?: number; onMessage?: (event: Pop3FetchEvent) => Promise<boolean | void> } = {},
) {
	const sessionDeadline = Math.min(Date.now() + EXTERNAL_SESSION_TIMEOUT_MS, options.deadlineAt ?? Number.POSITIVE_INFINITY);
	const transport = createFetchTransport(account, sessionDeadline);
	const callback = options.onMessage;
	const maxBatchBytes = options.maxBatchBytes ?? POP3_MAX_BATCH_BYTES;
	const commandDeadline = () => Math.min(sessionDeadline, Date.now() + EXTERNAL_COMMAND_TIMEOUT_MS);
	const deliver = async (event: Pop3FetchEvent) => {
		const result = callback ? await callback(event) : undefined;
		if (Date.now() >= sessionDeadline) throw new Error("timeout");
		return result !== false;
	};
	/** Writes one command line and returns the status reply; `+OK` text is carried, `-ERR` flips ok. */
	const exchange = async (verb: string): Promise<{ ok: boolean; text: string }> => {
		if (Date.now() >= sessionDeadline) throw new Error("timeout");
		transport.resetResponseMetadata();
		transport.write(`${verb}\r\n`);
		const line = await transport.readLine(commandDeadline());
		if (line.startsWith("+OK")) return { ok: true, text: line.slice(3).trim() };
		if (line.startsWith("-ERR")) return { ok: false, text: line.slice(4).trim() };
		throw new Error("invalid_response");
	};
	/** Reads a multiline listing to its "." terminator, dot-unstuffing each line and bounding the entry count. */
	const listing = async (onEntry: (line: string) => Promise<void>) => {
		let entries = 0;
		for (;;) {
			const line = await transport.readLine(commandDeadline(), false);
			if (line === ".") return;
			if (++entries > POP3_MAX_LIST_ENTRIES) throw new Error("response_limit");
			await onEntry(line.startsWith("..") ? line.slice(1) : line);
		}
	};
	/**
	 * Reads one RETR body up to the "\r\n.\r\n" terminator and reverses dot-stuffing. The leading CRLF of the
	 * terminator is the terminator's own, per RFC 1939, so bytes before it are the exact stored octets.
	 */
	const readBody = async (): Promise<Buffer> => {
		const maxWireBytes = MAX_RETR_WIRE_OVERHEAD(maxBytes);
		const parts: Buffer[] = [];
		let held = Buffer.alloc(0);
		let total = 0;
		let atStart = true;
		for (;;) {
			const chunk = await transport.readChunk(commandDeadline());
			const data = held.length ? Buffer.concat([held, chunk]) : chunk;
			let end = -1;
			// An empty message is just the "." line; a stuffed first line begins ".." and falls through to the scan.
			if (atStart && data.length >= 3 && data[0] === 0x2e && data[1] === 0x0d && data[2] === 0x0a) end = 0;
			if (end < 0) end = data.indexOf(MULTILINE_TERMINATOR);
			if (end >= 0) {
				const body = data.subarray(0, end);
				total += body.length;
				if (total > maxWireBytes) throw new Error("message_size_unverified");
				parts.push(body);
				const raw = dotUnstuff(Buffer.concat(parts, total));
				if (raw.byteLength > maxBytes) throw new Error("message_size_unverified");
				return raw;
			}
			// Keep the tail: a terminator split across chunks is matched once the rest of it arrives.
			const keep = Math.min(4, data.length);
			const emit = data.subarray(0, data.length - keep);
			held = Buffer.from(data.subarray(data.length - keep));
			if (emit.length) {
				total += emit.length;
				if (total > maxWireBytes) throw new Error("message_size_unverified");
				parts.push(emit);
				atStart = false;
			}
		}
	};
	const messages: Array<{ msgnum: number; uidlHash: string; raw: Buffer }> = [];
	const skippedUidls: string[] = [];
	let delivered = 0;
	let batchBytes = 0;
	let listed = 0;
	try {
		await transport.connect(account.tlsMode === "implicit-tls" ? "implicit-tls" : "plain", {
			greeting: async (readLine, deadline) => {
				const line = await readLine(deadline);
				if (!/^\+OK(?: |$)/i.test(line)) throw new Error("server_unavailable");
			},
			starttls: account.tlsMode === "starttls"
				? async (io, deadline) => {
					io.write("STLS\r\n");
					const line = await io.readLine(deadline);
					if (!/^\+OK/i.test(line)) throw new Error("tls_failed");
				}
				: undefined,
		});
		// USER admits no space (it would split the argument); PASS may contain spaces since it ends the line.
		if (!/^[\x21-\x7e]+$/.test(account.username) || !isSafeLoginArgument(account.password)) throw new Error("credentials_unsupported");
		if (!(await exchange(`USER ${account.username}`)).ok) throw new Error("authentication_failed");
		if (!(await exchange(`PASS ${account.password}`)).ok) throw new Error("authentication_failed");
		const stat = await exchange("STAT");
		if (!stat.ok) throw new Error("pop3_command_failed");
		const count = Number(stat.text.match(/^(\d+)/)?.[1]);
		if (count !== 0) {
			const uidl = await exchange("UIDL");
			if (!uidl.ok) throw new Error("uidl_unsupported");
			const candidates: Array<{ msgnum: number; uidlHash: string }> = [];
			await listing(async (line) => {
				const match = line.match(/^(\d+)\s+(\S+)$/);
				const msgnum = match ? Number(match[1]) : NaN;
				if (!match || !Number.isSafeInteger(msgnum) || msgnum < 1 || match[2].length > 128) throw new Error("invalid_response");
				listed++;
				const uidlHash = await pop3UidlHash(match[2]);
				if (!seen.has(uidlHash) && !skipped.has(uidlHash) && candidates.length < maxMessages) candidates.push({ msgnum, uidlHash });
			});
			candidates.sort((a, b) => a.msgnum - b.msgnum);
			for (const { msgnum, uidlHash } of candidates) {
				if (Date.now() >= sessionDeadline) throw new Error("timeout");
				const list = await exchange(`LIST ${msgnum}`);
				if (!list.ok) throw new Error("pop3_command_failed");
				const sizeMatch = list.text.match(/^(\d+)\s+(\d+)/);
				const size = sizeMatch ? Number(sizeMatch[2]) : NaN;
				if (!sizeMatch || Number(sizeMatch[1]) !== msgnum || !Number.isSafeInteger(size) || size < 0) throw new Error("invalid_response");
				if (size > maxBytes) {
					if (!await deliver({ msgnum, uidlHash, outcome: "oversized" })) break;
					skippedUidls.push(uidlHash);
					delivered++;
					continue;
				}
				const retr = await exchange(`RETR ${msgnum}`);
				if (!retr.ok) throw new Error("pop3_command_failed");
				const raw = await readBody();
				if (raw.byteLength + batchBytes > maxBatchBytes) break;
				const event = { msgnum, uidlHash, raw };
				if (!await deliver(event)) break;
				batchBytes += raw.byteLength;
				delivered++;
				if (!callback) messages.push(event);
			}
		}
		await exchange("QUIT").catch(() => {});
		transport.end();
		return { messages, delivered, skippedUidls, listed };
	} catch (error) {
		transport.destroy();
		throw error;
	}
}

/**
 * Reverses POP3 byte-stuffing (RFC 1939 section 3): a content line that begins with "." is sent with an
 * extra leading ".", removed here. Applied to the assembled body so a stuffing pair split across read
 * chunks cannot be missed.
 */
function dotUnstuff(buffer: Buffer): Buffer {
	const dot = 0x2e;
	const chunks: Buffer[] = [];
	let start = buffer.length >= 2 && buffer[0] === dot && buffer[1] === dot ? 1 : 0;
	let i = start;
	while (i <= buffer.length - 4) {
		if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === dot && buffer[i + 3] === dot) {
			chunks.push(buffer.subarray(start, i + 3));
			start = i + 4;
			i = start;
		} else {
			i++;
		}
	}
	if (start === 0 && chunks.length === 0) return buffer;
	chunks.push(buffer.subarray(start));
	return Buffer.concat(chunks);
}
