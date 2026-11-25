import { readFileSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { getDb } from "@/db";
import { authenticateAppPassword, allowAppPasswordGuess } from "@/lib/auth/app-passwords";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { isImapEnabled } from "@/lib/imap/settings";
import { imapMailboxBackend } from "./imap-mailbox-backend";
import {
	IMAP_APPEND_LIMIT,
	asImapSession,
	dispatchImapCommand,
	loginResult,
	parseImapCommand,
	quoteImapLiteral,
	type ImapMailboxBackend,
	type ImapSession,
} from "./imap-protocol";

const MAX_CLIENTS = 100;
const MAX_CONNECTIONS_PER_IP = 10;
const SOCKET_TIMEOUT_MS = 60_000;
const MAX_LINE_BYTES = 64 * 1024;
/** The largest literal one command may send, which is also the APPEND limit CAPABILITY advertises (RFC 7889). */
const MAX_LITERAL_BYTES = IMAP_APPEND_LIMIT;
/**
 * Total literal bytes buffered across every connection at once. A literal is reserved when its `{n}` marker is
 * read and given back when its command is answered, so this covers both the bytes being read and the ones
 * queued behind a pipelined command — 100 connections x a 10 MiB literal would otherwise be a gigabyte of
 * transient buffers, and one pipelining connection could hold that much by itself. Anything that does not fit
 * is refused the same way an oversized literal is, and its bytes are drained rather than stored.
 *
 * 32 MiB holds three full-size APPENDs at once (or a hundred ordinary ones), and the reader copies the buffer it
 * is filling on every chunk it receives, so an in-flight literal peaks at about twice its size: ~64 MiB of
 * literal memory plus ~6.3 MiB of line buffers at 100 connections, whatever the clients do.
 */
const MAX_BUFFERED_LITERAL_BYTES = 32 * 1024 * 1024;
type ImapOptions = {
	port: number;
	host?: string;
	tls: { keyPath: string; certPath: string } | null;
	/**
	 * How much literal data the listener will hold across every connection at once. The default
	 * (MAX_BUFFERED_LITERAL_BYTES) is what production runs; a smaller one is how a test proves the bound.
	 */
	bufferedLiteralBytes?: number;
};

/** Start an IMAP skeleton listener. Without certificate paths it accepts plaintext; configure TLS for credential privacy. */
export function startImapListener(env: CloudflareEnv, options: ImapOptions) {
	const connectionsByIp = new Map<string, number>();
	const admitted = new Set<Socket>();
	const maxBufferedLiteralBytes = options.bufferedLiteralBytes ?? MAX_BUFFERED_LITERAL_BYTES;
	// Shared by every connection: the budget literals are reserved from (see MAX_BUFFERED_LITERAL_BYTES).
	let bufferedLiteralBytes = 0;
	const onConnection = (socket: Socket) => {
		const ip = socket.remoteAddress ?? "unknown";
		const count = (connectionsByIp.get(ip) ?? 0) + 1;
		if (count > MAX_CONNECTIONS_PER_IP || admitted.size >= MAX_CLIENTS) { socket.end("* BYE Too many connections\r\n"); return; }
		admitted.add(socket);
		connectionsByIp.set(ip, count);
		socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
		socket.write("* OK Mailflare IMAP4rev1 server ready\r\n");
		let buffer = Buffer.alloc(0);
		let pendingPrefix: string | null = null;
		let pendingLiteralLength = 0;
		// A binary literal for APPEND: the raw bytes are not run through the quoted-string tokenizer, so they
		// reach the import seam exactly as the client sent them (attachments included).
		let pendingAppendLiteral: { prefix: string; literal: Buffer; reserved: number } | null = null;
		// Literal bytes this connection holds from the budget, split between the literal being read and the ones
		// already folded into a command line that is queued or being assembled.
		let heldLiteralBytes = 0;
		let pendingLiteralReserved = 0;
		let pendingLineReserved = 0;
		// Bytes of a refused literal still to be thrown away, and the CRLF that ends its command line after them.
		let pendingDrainBytes = 0;
		let pendingDrainTerminator = false;
		const session: ImapSession = asImapSession("not-authenticated");
		let auth: ApiAuthResult | null = null;
		// One backend per login. It reads the catalogue fresh on every call, so a folder written
		// through CREATE (or another session) is visible to the next LIST without a reconnect.
		let backend: ImapMailboxBackend | null = null;

		/** Claim room for one literal, or say no: over the per-command limit, or the server-wide budget is full. */
		const reserveLiteral = (size: number) => {
			if (size > MAX_LITERAL_BYTES || bufferedLiteralBytes + size > maxBufferedLiteralBytes) return false;
			bufferedLiteralBytes += size;
			heldLiteralBytes += size;
			return true;
		};
		const releaseLiteral = (reserved: number) => {
			// A close may have given back everything this connection held, so never return more than is still held.
			const amount = Math.min(reserved, heldLiteralBytes);
			heldLiteralBytes -= amount;
			bufferedLiteralBytes -= amount;
		};

		let commandQueue = Promise.resolve();
		const enqueueLine = (line: string, literal: Buffer | null = null, reserved = 0) => {
			commandQueue = commandQueue
				.then(() => handleLine(line, literal))
				.catch((error: unknown) => {
					console.error("IMAP command failed", error);
					socket.write("* BYE Temporary server error\r\n");
					socket.end();
				})
				// The literal stays reserved while its command is queued: answering it is when the bytes are done with.
				.finally(() => {
					if (reserved > 0) releaseLiteral(reserved);
				});
		};
		const handleLine = async (line: string, literal: Buffer | null) => {
			const command = parseImapCommand(line);
			if (!command) { socket.write("* BAD Invalid command syntax\r\n"); return; }
			// APPEND's literal is the message itself, so it travels beside the arguments rather than as a token.
			if (literal) command.literal = literal.buffer.slice(literal.byteOffset, literal.byteOffset + literal.byteLength) as ArrayBuffer;
			const mailboxBackend = auth ? (backend ??= imapMailboxBackend(getDb(env), auth, env)) : undefined;
			const action = await dispatchImapCommand(session, command, mailboxBackend);
			if (action.login) {
				if (!(await isImapEnabled(env))) { socket.write(`${command.tag} NO IMAP disabled\r\n`); return; }
				const ipAddress = socket.remoteAddress ?? null;
				const request = new Request("http://localhost/", { headers: ipAddress ? { "x-mailflare-client-ip": ipAddress } : {} });
				const secret = action.login.password.replace(/[\s-]/g, "");
				const allowed = await allowAppPasswordGuess(env, request, secret, "app");
				const authed = allowed && await authenticateAppPassword(env, { secret, protocol: "imap", clientIp: ipAddress });
				const result = loginResult(command.tag, !!authed);
				auth = authed || null;
				backend = null;
				session.state = result.state ?? session.state;
				session.selected = null;
				socket.write(result.response);
				return;
			}
			session.state = action.state ?? session.state;
			if (action.selected !== undefined) session.selected = action.selected;
			socket.write(action.response);
			if (session.state === "logged-out") { auth = null; backend = null; socket.end(); }
		};

		/**
		 * Refuse a literal the server will not buffer. RFC 3501 §4.3 makes a tagged NO (or BAD) in place of the
		 * continuation the right answer, which is what keeps the connection: a synchronizing literal is refused
		 * before the client sends a byte, and the session carries on with the next command.
		 *
		 * A refused literal whose bytes are already on the way still has to be consumed before the next command line
		 * can be framed: LITERAL+ (`{n+}`) never waits for the continuation, and a pipelining client may have put its
		 * payload on the wire ahead of this answer. Those bytes are drained, not parsed. The one case left is a
		 * synchronizing literal whose payload the client sends anyway, after this NO: its bytes are read as command
		 * lines (each answers BAD) until it happens to send one that parses — a client that does that has already
		 * broken RFC 3501 §4.3, and the drain cannot tell its payload from its next command.
		 */
		const refuseLiteral = (prefix: string, declared: number, nonSynchronizing: boolean) => {
			const tag = /^([^\s{}]+)\s/.exec(prefix)?.[1];
			socket.write(tag ? `${tag} NO Literal too large\r\n` : "* BAD Literal too large\r\n");
			if (declared > 0 && (nonSynchronizing || buffer.length > 0)) pendingDrainBytes = declared;
		};

		const consume = () => {
			while (!socket.destroyed) {
				// Throwing away a refused literal costs only the chunk being dropped: the bytes are sliced off, never copied.
				if (pendingDrainBytes > 0 || pendingDrainTerminator) {
					if (pendingDrainBytes > 0) {
						const taken = Math.min(pendingDrainBytes, buffer.length);
						buffer = buffer.subarray(taken);
						pendingDrainBytes -= taken;
						if (pendingDrainBytes > 0) return;
						pendingDrainTerminator = true;
					}
					// The literal is followed by the CRLF that ends the command line it belonged to (RFC 3501 §4.3).
					const terminator = buffer.indexOf("\r\n");
					if (terminator < 0) {
						if (buffer.length > MAX_LINE_BYTES) { socket.write("* BAD Command line too long\r\n"); socket.destroy(); }
						return;
					}
					buffer = buffer.subarray(terminator + 2);
					pendingDrainTerminator = false;
					continue;
				}
				if (pendingAppendLiteral !== null) {
					// The literal is followed by the CRLF that ends the command line (RFC 3501 §4.3).
					const end = buffer.indexOf("\r\n");
					if (end < 0) {
						if (buffer.length > MAX_LINE_BYTES) { socket.write("* BAD Command line too long\r\n"); socket.destroy(); }
						return;
					}
					const tail = buffer.subarray(0, end).toString("utf8");
					buffer = buffer.subarray(end + 2);
					const { prefix, literal, reserved } = pendingAppendLiteral;
					pendingAppendLiteral = null;
					enqueueLine(prefix + tail, literal, reserved);
					continue;
				}
				if (pendingPrefix !== null) {
					if (buffer.length < pendingLiteralLength) return;
					const literal = buffer.subarray(0, pendingLiteralLength);
					const rest = buffer.subarray(pendingLiteralLength);
					const prefix = pendingPrefix;
					const reserved = pendingLiteralReserved;
					pendingPrefix = null;
					pendingLiteralReserved = 0;
					// APPEND carries a message, not a name: keep the bytes and wait for the line terminator.
					if (/^\S+\s+APPEND(\s|$)/i.test(prefix)) {
						pendingAppendLiteral = { prefix, literal: Buffer.from(literal), reserved };
						buffer = rest;
						continue;
					}
					// Every other literal is a mailbox name or a credential, which the tokenizer can read as a quoted string.
					buffer = Buffer.concat([Buffer.from(prefix + quoteImapLiteral(literal.toString("utf8"))), rest]);
					// Its bytes now live in that line, so the reservation moves with the line rather than ending here.
					pendingLineReserved += reserved;
					continue;
				}
				const end = buffer.indexOf("\r\n");
				if (end < 0) {
					if (buffer.length > MAX_LINE_BYTES) { socket.write("* BAD Command line too long\r\n"); socket.destroy(); }
					return;
				}
				const line = buffer.subarray(0, end).toString("utf8");
				buffer = buffer.subarray(end + 2);
				const literal = /\{(\d+)\+?\}$/.exec(line);
				if (literal) {
					const declared = Number(literal[1]);
					const prefix = line.slice(0, literal.index);
					// `{n+}` (LITERAL+) means the client sends the bytes without waiting for the continuation.
					const nonSynchronizing = literal[0].endsWith("+");
					if (!Number.isSafeInteger(declared) || !reserveLiteral(declared)) { refuseLiteral(prefix, Number.isSafeInteger(declared) ? declared : 0, nonSynchronizing); continue; }
					pendingLiteralLength = declared;
					pendingLiteralReserved = declared;
					pendingPrefix = prefix;
					if (!nonSynchronizing) socket.write("+ Ready for literal data\r\n");
					continue;
				}
				enqueueLine(line, null, pendingLineReserved);
				pendingLineReserved = 0;
			}
		};
		socket.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); consume(); });
		socket.on("close", () => {
			// Whatever this connection still held goes back to the budget before anything else, including the
			// literals of commands that were queued but never answered.
			bufferedLiteralBytes -= heldLiteralBytes;
			heldLiteralBytes = 0;
			if (!admitted.delete(socket)) return;
			const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
			if (remaining <= 0) connectionsByIp.delete(ip);
			else connectionsByIp.set(ip, remaining);
		});
	};
	const server = options.tls
		? createTlsServer({ key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) }, onConnection)
		: createNetServer(onConnection);
	server.on("error", (error) => console.error("IMAP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => console.log(`IMAP listener listening on ${options.host ?? "0.0.0.0"}:${options.port}${options.tls ? " (TLS)" : " (plaintext)"}`));
	return server;
}
