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
	IMAP_IDLE_MAX_MS,
	IMAP_IDLE_POLL_MS,
	asImapSession,
	dispatchImapCommand,
	idleBusyResponse,
	isImapIdleDone,
	loginResult,
	parseImapCommand,
	quoteImapLiteral,
	type ImapCommand,
	type ImapIdleStart,
	type ImapMailboxBackend,
	type ImapMailboxCounts,
	type ImapSession,
} from "./imap-protocol";

const MAX_CLIENTS = 100;
const MAX_CONNECTIONS_PER_IP = 10;
/**
 * How long a connection that is not idling may stay quiet before it is closed. RFC 3501 §5.4 asks for an
 * inactivity timeout of at least 30 minutes; this value predates IDLE and is deliberately shorter for the
 * bridge. An IDLE is exempt from it (see `startIdle`), because an idling client is supposed to be silent, and
 * its own silence is bounded by IMAP_IDLE_MAX_MS instead. A later change to SOCKET_TIMEOUT_MS should raise it
 * towards the RFC minimum; it is not raised here to keep this slice's behaviour identical for non-idling sessions.
 */
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
	/**
	 * How long an IDLE waits between count polls, and how long one IDLE may run before the server ends it with a
	 * tagged OK. The defaults are the contract (`IMAP_IDLE_POLL_MS`, `IMAP_IDLE_MAX_MS`); a test shortens them so
	 * the timers can be observed inside its own lifetime.
	 */
	idlePollMs?: number;
	idleMaxMs?: number;
	/**
	 * The silence that closes a connection which is not idling. The default (SOCKET_TIMEOUT_MS) is what production
	 * runs; a test shortens it to prove an IDLE is exempt from it.
	 */
	inactivityTimeoutMs?: number;
};

/** Start an IMAP skeleton listener. Without certificate paths it accepts plaintext; configure TLS for credential privacy. */
export function startImapListener(env: CloudflareEnv, options: ImapOptions) {
	const connectionsByIp = new Map<string, number>();
	const admitted = new Set<Socket>();
	const maxBufferedLiteralBytes = options.bufferedLiteralBytes ?? MAX_BUFFERED_LITERAL_BYTES;
	const idlePollMs = options.idlePollMs ?? IMAP_IDLE_POLL_MS;
	const idleMaxMs = options.idleMaxMs ?? IMAP_IDLE_MAX_MS;
	const inactivityTimeoutMs = options.inactivityTimeoutMs ?? SOCKET_TIMEOUT_MS;
	// Shared by every connection: the budget literals are reserved from (see MAX_BUFFERED_LITERAL_BYTES).
	let bufferedLiteralBytes = 0;
	const onConnection = (socket: Socket) => {
		const ip = socket.remoteAddress ?? "unknown";
		const count = (connectionsByIp.get(ip) ?? 0) + 1;
		if (count > MAX_CONNECTIONS_PER_IP || admitted.size >= MAX_CLIENTS) { socket.end("* BYE Too many connections\r\n"); return; }
		admitted.add(socket);
		connectionsByIp.set(ip, count);
		// One timeout listener for the connection's life rather than a callback per arming: IDLE disarms and re-arms
		// this timer on every cycle, and a callback per arm would stack listeners on a long-lived session.
		socket.on("timeout", () => socket.destroy());
		socket.setTimeout(inactivityTimeoutMs);
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
		// The last message count this session told the client its selection holds: SELECT's EXISTS, then every IDLE
		// push. An IDLE that starts after mail arrived can announce it immediately instead of waiting a poll.
		let reportedMessages: number | null = null;
		/**
		 * The running IDLE, if there is one: `+ idling` has been written and the mailbox is re-read until DONE or the
		 * re-arm window closes. `count` is bound to the login's backend and the entry IDLE resolved, so a poll cannot
		 * read a different mailbox than the one the client selected.
		 */
		type ConnectionIdle = {
			tag: string;
			/** The highest total the client has been told; a poll only ever emits a total above it. */
			messages: number;
			count: () => Promise<ImapMailboxCounts | null>;
			poll: ReturnType<typeof setTimeout> | null;
			deadline: ReturnType<typeof setTimeout>;
		};
		let idle: ConnectionIdle | null = null;
		// A client may pipeline DONE straight behind IDLE, before this connection has answered the IDLE: those lines
		// wait here until the IDLE is accepted or refused, then go to the idle line handler or back through the queue.
		let idleEntering = false;
		let idlePrelude: Array<{ line: string; literal: Buffer | null; reserved: number }> = [];

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

		/** Write IDLE's one untagged response, and remember it as the count the client now knows. */
		const writeExists = (messages: number) => {
			reportedMessages = messages;
			socket.write(`* ${messages} EXISTS\r\n`);
		};

		/** Drop the running IDLE's timers. Returns it when there was one, so the caller can decide what to write. */
		const stopIdle = () => {
			const current = idle;
			idle = null;
			if (!current) return null;
			if (current.poll) clearTimeout(current.poll);
			clearTimeout(current.deadline);
			return current;
		};

		/**
		 * End the IDLE the way RFC 2177 asks: a tagged OK answering the IDLE command's tag, with the session still
		 * selected. DONE and the re-arm deadline reach here the same way — the client that is still there ends its
		 * own IDLE, and the one that went quiet learns the server did, and may send IDLE again.
		 */
		const endIdle = () => {
			const current = stopIdle();
			if (!current || socket.destroyed) return;
			// The silence exemption lasted exactly as long as the IDLE: the ordinary inactivity contract is armed again.
			socket.setTimeout(inactivityTimeoutMs);
			socket.write(`${current.tag} OK Idle terminated\r\n`);
		};

		/** A recursive timeout rather than an interval, so a count query slower than the poll cannot stack polls. */
		const scheduleIdlePoll = (current: ConnectionIdle) => {
			current.poll = setTimeout(() => void pollIdle(current), idlePollMs);
		};

		const pollIdle = async (current: ConnectionIdle) => {
			current.poll = null;
			if (idle !== current || socket.destroyed) return;
			try {
				const counts = await current.count();
				// DONE, the deadline or a close may have landed while the count was being read.
				if (idle !== current || socket.destroyed) return;
				// `null` means the user may no longer read this mailbox (a revoked grant, a disabled or deleted mailbox):
				// end the IDLE without a count rather than keep reporting a mailbox the session has lost access to.
				if (counts === null) { endIdle(); return; }
				// RFC 3501 §5.2: only an EXPUNGE may lower the selected mailbox's count, and this bridge cannot name the
				// rows a positional EXPUNGE would (sequence = UID, so a deletion shifts every later number). A total that
				// fell is therefore not pushed at all: the client learns the true count from its next SELECT, STATUS or
				// NOOP, or when the mailbox grows past the total it was last told. Emitting only above the baseline keeps
				// the EXISTS stream monotonic, which is what the protocol requires.
				if (counts.messages > current.messages) {
					current.messages = counts.messages;
					writeExists(counts.messages);
				}
			} catch (error) {
				// A count that could not be read is not a reason to lose the session: the next poll tries again.
				console.error("IMAP IDLE poll failed", error);
			}
			if (idle === current && !socket.destroyed) scheduleIdlePoll(current);
		};

		/** Start the machinery `+ idling` opened: the deadline, the first poll, and any change since SELECT. */
		const startIdle = (start: ImapIdleStart, mailboxBackend: ImapMailboxBackend) => {
			// The socket can close while the IDLE's entry count is being read: arming a 29-minute deadline on a dead
			// socket would leave a timer that can never write anything.
			if (socket.destroyed) return;
			// `+ idling` has already been written. An idling client is legitimately silent until DONE, so the inactivity
			// timer is disabled rather than merely refreshed — the deadline below is what bounds the silence instead.
			socket.setTimeout(0);
			// The baseline is the highest total the client knows: the one this IDLE just counted, or the one it was last
			// told if a shrink was suppressed in between. Only a total above it can be announced, never below.
			const baseline = reportedMessages === null ? start.messages : Math.max(reportedMessages, start.messages);
			const current: ConnectionIdle = {
				tag: start.tag,
				messages: baseline,
				count: () => mailboxBackend.idleCounts(start.entry),
				poll: null,
				deadline: setTimeout(endIdle, idleMaxMs),
			};
			idle = current;
			// Mail that arrived between the count the client was told and `+ idling` is reported now, so its view is
			// current before it starts waiting; an unchanged mailbox says nothing at all.
			if (reportedMessages !== null && start.messages > reportedMessages) writeExists(start.messages);
			scheduleIdlePoll(current);
		};

		/** While idling, DONE is the only line that means anything (RFC 2177); everything else is a BAD. */
		const handleIdleLine = (line: string, command: ImapCommand | null) => {
			if (isImapIdleDone(line)) { endIdle(); return; }
			socket.write(idleBusyResponse(command));
		};

		let commandQueue = Promise.resolve();
		const enqueueLine = (line: string, literal: Buffer | null = null, reserved = 0) => {
			// An IDLE is not a command the queue may wait on: the DONE line has to be read off the wire while the IDLE
			// is open, so an idling connection's lines never enter the queue at all.
			const command = parseImapCommand(line);
			if (idle) {
				if (reserved > 0) releaseLiteral(reserved);
				handleIdleLine(line, command);
				return;
			}
			if (idleEntering) { idlePrelude.push({ line, literal, reserved }); return; }
			if (command?.verb === "IDLE") idleEntering = true;
			commandQueue = commandQueue
				.then(() => handleLine(command, literal))
				.catch((error: unknown) => {
					console.error("IMAP command failed", error);
					socket.write("* BYE Temporary server error\r\n");
					socket.end();
				})
				// The literal stays reserved while its command is queued: answering it is when the bytes are done with.
				.finally(() => {
					// Lines that arrived behind the IDLE now know whether it is idling or whether they are ordinary commands.
					if (command?.verb === "IDLE") settleIdlePrelude();
					if (reserved > 0) releaseLiteral(reserved);
				});
		};
		const settleIdlePrelude = () => {
			idleEntering = false;
			const prelude = idlePrelude;
			idlePrelude = [];
			// Replaying through enqueueLine is what routes each line: to the idle handler when the IDLE was accepted,
			// back through the queue when it was refused (a refused IDLE leaves this connection not idling).
			for (const item of prelude) enqueueLine(item.line, item.literal, item.reserved);
		};
		const handleLine = async (command: ImapCommand | null, literal: Buffer | null) => {
			if (!command) { socket.write("* BAD Invalid command syntax\r\n"); return; }
			// APPEND's literal is the message itself, so it travels beside the arguments rather than as a token.
			if (literal) command.literal = literal.buffer.slice(literal.byteOffset, literal.byteOffset + literal.byteLength) as ArrayBuffer;
			const mailboxBackend = auth ? (backend ??= imapMailboxBackend(getDb(env), auth, env)) : undefined;
			const action = await dispatchImapCommand(session, command, mailboxBackend);
			// The socket can be gone by the time an async command resolves (a client that closed while its count was
			// being read). Replying to it, and above all arming an IDLE's 29-minute deadline on it, would be work for a
			// connection that no longer exists.
			if (socket.destroyed) return;
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
				reportedMessages = null;
				socket.write(result.response);
				return;
			}
			session.state = action.state ?? session.state;
			if (action.selected !== undefined) {
				session.selected = action.selected;
				// A deselect leaves no selected count for this session to have been told about.
				if (action.selected === null) reportedMessages = null;
			}
			if (action.messages !== undefined) reportedMessages = action.messages;
			socket.write(action.response);
			if (action.idle && mailboxBackend) startIdle(action.idle, mailboxBackend);
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

		/**
		 * Refuse a literal-bearing line while an IDLE is open (or queued and not yet answered). The marker never becomes
		 * a continuation, so a synchronizing literal is refused before the client sends a byte (RFC 3501 §4.3) and a
		 * later `DONE` still frames as a line, not as payload.
		 *
		 * A LITERAL+ payload is already on the wire — `{n+}` never waits for a continuation — so those declared bytes
		 * and the CRLF ending the command line are drained, exactly like any other refused literal: the bytes are never
		 * read as command lines, and text inside them that looks like DONE cannot end the IDLE. A synchronizing literal
		 * gets nothing drained, because this connection never sent the continuation, so a client that was refused owes
		 * no bytes: whatever follows frames as its next command line (each answers BAD while the IDLE is open), which
		 * keeps a legitimately pipelined `DONE` working instead of swallowing it as a payload nobody asked for.
		 *
		 * Draining is byte-level and has to happen now; the answer keeps its place in the command order behind the
		 * IDLE. An answered IDLE has nothing queued, so its refusal can be written straight away, while one that is
		 * still being decided owns the next reply and the BAD waits for it.
		 */
		const refuseLiteralWhileIdle = (prefix: string, declared: number, nonSynchronizing: boolean) => {
			if (declared > 0 && nonSynchronizing) pendingDrainBytes = declared;
			const response = idleBusyResponse(parseImapCommand(prefix));
			if (idle) { socket.write(response); return; }
			commandQueue = commandQueue.then(() => { if (!socket.destroyed) socket.write(response); });
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
				const literal = /\{(\d+)(\+)?\}$/.exec(line);
				if (literal) {
					const declared = Number(literal[1]);
					const prefix = line.slice(0, literal.index);
					// `{n+}` (LITERAL+) means the client sends the bytes without waiting for the continuation.
					// The `+` is inside the braces (`{n+}`), so it is the captured group that says LITERAL+ rather than the tail.
					const nonSynchronizing = Boolean(literal[2]);
					// An IDLE is open (or is being answered): RFC 2177 gives the client nothing to send in that state but
					// DONE, so a literal is refused before this connection enters literal mode. Otherwise a client could get
					// `+ Ready for literal data` in reply to a command it should not have sent, and a later DONE-looking line
					// would be framed as payload instead of ending the IDLE.
					if (idle || idleEntering) { refuseLiteralWhileIdle(prefix, Number.isSafeInteger(declared) ? declared : 0, nonSynchronizing); continue; }
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
			// An idling connection must not leave its poll behind: the timer would keep reading counts for a client that
			// is gone, and would keep the connection's socket alive in the event loop.
			stopIdle();
			idleEntering = false;
			idlePrelude = [];
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
