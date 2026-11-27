import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tcpConnect } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

/** A single fetch session may not outlive this; the poll loop's account deadline can shorten it. */
export const EXTERNAL_SESSION_TIMEOUT_MS = 45_000;
export const EXTERNAL_COMMAND_TIMEOUT_MS = 12_000;
const MAX_BUFFERED_SOCKET_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_RESPONSE_METADATA_BYTES = 512 * 1024;

type Socket = import("node:net").Socket;

export type FetchTransportHooks = {
	/** Validates the server's first line after connect (and after a refused upgrade the attempt is retried). */
	greeting: (readLine: (deadline: number) => Promise<string>, deadline: number) => Promise<void>;
	/**
	 * Performs the protocol's plaintext upgrade exchange (STARTTLS/STLS) before the socket is wrapped in TLS.
	 * A rejection throws: the poller must not fall back to plaintext, but the next checked address is tried.
	 */
	starttls?: (io: { readLine: (deadline: number) => Promise<string>; write: (data: string | Buffer) => void }, deadline: number) => Promise<void>;
};

/**
 * Shared TCP/TLS transport for the external-account fetch clients (IMAP, POP3), Node runtime only.
 *
 * The egress policy lives here exactly once: the hostname is resolved afresh per session and only the checked
 * numeric results are dialed, closing the DNS-rebind gap; private ranges are refused unless the operator opted
 * in. Both clients share the same line/byte readers, buffer and metadata bounds, deadline handling and the
 * verified-TLS upgrade path (implicit connect or plaintext upgrade). Errors intentionally omit wire text and
 * credentials.
 */
export function createFetchTransport(
	target: { host: string; port: number; allowPrivate?: boolean },
	sessionDeadline: number,
) {
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
	/** Returns the next queued socket chunk, whatever its size, for byte-level framing such as POP3 multiline reads. */
	const readChunk = async (deadline: number): Promise<Buffer> => {
		if (!bufferedBytes) await waitForData(deadline);
		const chunk = receive[0];
		receive.shift(); bufferedBytes -= chunk.length;
		return chunk;
	};
	/**
	 * One CRLF-terminated line as ASCII without the terminator, bounded per line and — when `metadata` is set —
	 * charged to the response-metadata budget. Protocol data with its own bound (a POP3 multiline listing)
	 * passes `metadata: false` and enforces its own cap instead.
	 */
	const readLine = async (deadline: number, metadata = true): Promise<string> => {
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
				if (metadata) {
					responseMetadataBytes += length;
					if (responseMetadataBytes > MAX_RESPONSE_METADATA_BYTES) throw new Error("response_limit");
				}
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
		const addresses = isIP(target.host) ? [{ address: target.host }] : await withDeadline(lookup(target.host, { all: true, verbatim: true }), Math.min(sessionDeadline, Date.now() + EXTERNAL_COMMAND_TIMEOUT_MS));
		if (!addresses.length) throw new Error("connection_failed");
		if (!target.allowPrivate && addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("egress_denied");
		return [...new Set(addresses.map(({ address }) => address))].slice(0, 8);
	};
	const write = (data: string | Buffer) => {
		if (closed || !socket || socket.destroyed) throw new Error("connection_failed");
		socket.write(data);
	};
	const connect = async (mode: "plain" | "implicit-tls", hooks: FetchTransportHooks) => {
		const addresses = await dialAddresses();
		let lastError: unknown = new Error("connection_failed");
		for (const address of addresses) {
			if (Date.now() >= sessionDeadline) throw new Error("timeout");
			let candidate: Socket | undefined;
			try {
				if (mode === "plain") {
					const plain = tcpConnect({ host: address, port: target.port });
					candidate = plain;
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => { plain.destroy(); reject(new Error("timeout")); }, Math.min(EXTERNAL_COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
						plain.once("connect", () => { clearTimeout(timer); resolve(); });
						plain.once("error", () => { clearTimeout(timer); reject(new Error("connection_failed")); });
					});
					attach(plain);
				} else {
					const secure = tlsConnect({ host: address, port: target.port, ...(isIP(target.host) ? {} : { servername: target.host }), rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(target.host, cert) });
					candidate = secure;
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => { secure.destroy(); reject(new Error("timeout")); }, Math.min(EXTERNAL_COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
						secure.once("secureConnect", () => { clearTimeout(timer); resolve(); });
						secure.once("error", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
						secure.once("end", () => { clearTimeout(timer); reject(new Error("tls_failed")); });
						secure.once("close", () => { if (!secure.authorized) { clearTimeout(timer); reject(new Error("tls_failed")); } });
					});
					attach(secure);
				}
				await hooks.greeting(readLine, Math.min(sessionDeadline, Date.now() + EXTERNAL_COMMAND_TIMEOUT_MS));
				if (hooks.starttls) {
					await hooks.starttls({ readLine, write }, Math.min(sessionDeadline, Date.now() + EXTERNAL_COMMAND_TIMEOUT_MS));
					const plain = socket!;
					plain.removeAllListeners("data"); plain.removeAllListeners("error"); plain.removeAllListeners("end"); plain.removeAllListeners("close");
					receive.length = 0; bufferedBytes = 0; closed = false;
					const secure = tlsConnect({ socket: plain, ...(isIP(target.host) ? {} : { servername: target.host }), rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(target.host, cert) });
					candidate = secure;
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => { secure.destroy(); reject(new Error("timeout")); }, Math.min(EXTERNAL_COMMAND_TIMEOUT_MS, sessionDeadline - Date.now()));
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
	const end = () => { if (sessionTimer) clearTimeout(sessionTimer); socket?.end(); };
	const destroy = () => { if (sessionTimer) clearTimeout(sessionTimer); socket?.destroy(); };
	return {
		connect,
		readLine,
		readBytes,
		readChunk,
		write,
		end,
		destroy,
		isClosed: () => closed || !socket || socket.destroyed,
		resetResponseMetadata: () => { responseMetadataBytes = 0; },
	};
}

export type FetchTransport = ReturnType<typeof createFetchTransport>;

export async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, deadline - Date.now())); })]);
	} finally { if (timer) clearTimeout(timer); }
}
export function isSafeLoginArgument(value: string) { return /^[\x20-\x7e]+$/.test(value) && !/[\r\n\0]/.test(value); }
export function quote(value: string) { return `"${value.replace(/[\\"]/g, "\\$&")}"`; }

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
