import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-imap-append-literal-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * The socket layer's literal framing, over a real TCP connection: APPEND is the first command whose literal is
 * binary (a raw MIME message, CRLFs and 8-bit bytes included), so it cannot travel through the quoted-string
 * tokenizer the mailbox-name literals use. The auth, settings and backend modules are stubbed — this suite is
 * about the bytes the reader hands to the dispatcher, not about authentication.
 */
await build({
	stdin: {
		contents: `export { startImapListener } from "./server/runtime/imap.ts";`,
		resolveDir: root,
		sourcefile: "imap-append-literal-entry.ts",
	},
	outfile: join(outDir, "listener.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "imap-append-literal-mocks",
		setup(builder) {
			const alias = (filter, namespace, contents) => {
				builder.onResolve({ filter }, () => ({ path: namespace, namespace }));
				builder.onLoad({ filter: /.*/, namespace }, () => ({ loader: "js", contents }));
			};
			alias(/^@\/db$/, "mock-db", "export function getDb() { return {}; }");
			alias(/^@\/lib\/auth\/app-passwords$/, "mock-app-passwords", `
				export async function allowAppPasswordGuess() { return true; }
				export async function authenticateAppPassword() { return globalThis.__auth; }
			`);
			alias(/^@\/lib\/imap\/settings$/, "mock-imap-settings", "export async function isImapEnabled() { return true; }");
			alias(/^\.\/imap-mailbox-backend$/, "mock-imap-backend", `
				export function imapMailboxBackend() {
					globalThis.__backendCalls = (globalThis.__backendCalls ?? 0) + 1;
					return globalThis.__backend;
				}
			`);
		},
	}],
});

const { startImapListener } = await import(pathToFileURL(join(outDir, "listener.mjs")).href);

const ENTRY = { name: "INBOX", ref: "mbx1~inbox", mailboxId: "mbx1", role: "inbox", folderId: null, selectable: true };
const appends = [];
globalThis.__auth = { userId: "u1", email: "alice@example.test", user: { id: "u1", role: "member" }, mailboxIds: null, keyId: "k1", keyKind: "app", scopes: [] };
globalThis.__backend = {
	list: async () => [ENTRY],
	counts: async () => ({ messages: 0, unseen: 0 }),
	messages: async () => [],
	append: async (request) => {
		appends.push(request);
		return "ok";
	},
};

let server;
let port;
before(async () => {
	server = startImapListener({}, { port: 0, tls: null });
	await new Promise((resolve) => server.once("listening", resolve));
	port = server.address().port;
});
after(() => server?.close());

/** A client that keeps everything it has read, so a response can be awaited before the next command is sent. */
function openClient() {
	const socket = connect(port, "127.0.0.1");
	let received = "";
	const pending = [];
	const flush = () => {
		for (const waiter of [...pending]) {
			if (received.includes(waiter.text)) {
				const index = received.indexOf(waiter.text);
				const all = received.slice(0, index + waiter.text.length);
				received = received.slice(index + waiter.text.length);
				pending.splice(pending.indexOf(waiter), 1);
				waiter.resolve(all);
			}
		}
	};
	socket.setEncoding("latin1");
	socket.on("data", (chunk) => {
		received += chunk;
		flush();
	});
	const closed = new Promise((resolve) => socket.once("close", resolve));
	const waitFor = (text) =>
		new Promise((resolve, reject) => {
			pending.push({ text, resolve });
			flush();
			setTimeout(() => reject(new Error(`timed out waiting for ${JSON.stringify(text)}; got ${JSON.stringify(received)}`)), 5_000).unref();
		});
	const send = (data) => socket.write(data);
	return { send, waitFor, closed, socket, received: () => received };
}

/** Raw MIME with CRLFs, a nested boundary and bytes that are not valid UTF-8, like a real attachment part. */
const rawMessage = Buffer.concat([
	Buffer.from(
		[
			"From: Kevin <kevin@example.com>",
			"To: Iris <iris@example.org>",
			"Subject: Offer",
			"Message-ID: <offer-1@example.com>",
			"Date: Tue, 2 Feb 2021 10:00:00 +0000",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b1"',
			"",
			"--b1",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"Hello {5} world",
			"",
			"--b1",
			'Content-Type: application/octet-stream; name="blob.bin"',
			"Content-Transfer-Encoding: binary",
			"",
			"",
		].join("\r\n"),
		"utf8",
	),
	// 0x80..0xFF are not valid UTF-8: a text round trip would replace them, so this pins byte fidelity.
	Buffer.from([0x00, 0x80, 0xc3, 0x28, 0xff, 0xfe, 0x0d, 0x0a]),
	Buffer.from("\r\n--b1--\r\n", "utf8"),
]);

test("APPEND reads a synchronizing literal byte for byte, including CRLFs and 8-bit content", async () => {
	const client = openClient();
	await client.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	client.send("A1 LOGIN alice secret\r\n");
	await client.waitFor("A1 OK LOGIN completed\r\n");

	// A synchronizing literal: the server asks for the bytes before the client sends them (RFC 3501 §4.3).
	client.send(`A2 APPEND INBOX (\\Seen) {${rawMessage.length}}\r\n`);
	await client.waitFor("+ Ready for literal data\r\n");
	client.send(rawMessage);
	client.send("\r\n");
	await client.waitFor("A2 OK APPEND completed\r\n");

	assert.equal(appends.length, 1);
	assert.equal(appends[0].entry.ref, "mbx1~inbox");
	assert.deepEqual(appends[0].flags, ["\\Seen"]);
	const received = Buffer.from(appends[0].raw);
	assert.equal(received.length, rawMessage.length);
	// The whole message, not a line of it: the reader frames on the declared length, so an interior CRLF is data.
	assert.deepEqual(received, rawMessage);
	assert.ok(received.includes(Buffer.from([0x80, 0xc3, 0x28, 0xff, 0xfe])));
	client.socket.destroy();
	await client.closed;
});

test("APPEND accepts a non-synchronizing literal and keeps command order", async () => {
	const client = openClient();
	await client.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	client.send("B1 LOGIN alice secret\r\n");
	await client.waitFor("B1 OK LOGIN completed\r\n");
	const small = Buffer.from("From: a@b.test\r\nSubject: One\r\n\r\nhi\r\n", "utf8");
	const other = Buffer.from("From: a@b.test\r\nSubject: Two\r\n\r\nhi\r\n", "utf8");
	// `{n+}` (LITERAL+) sends the bytes without waiting for a continuation, and both commands arrive pipelined
	// in one write: the queue is what keeps them ordered.
	const before = appends.length;
	client.send(Buffer.concat([
		Buffer.from(`B2 APPEND INBOX {${small.length}+}\r\n`, "utf8"),
		small,
		Buffer.from("\r\n", "utf8"),
		Buffer.from(`B3 APPEND INBOX {${other.length}+}\r\n`, "utf8"),
		other,
		Buffer.from("\r\nB4 NOOP\r\n", "utf8"),
	]));
	await client.waitFor("B2 OK APPEND completed\r\n");
	await client.waitFor("B3 OK APPEND completed\r\n");
	await client.waitFor("B4 OK NOOP completed\r\n");
	assert.deepEqual(appends.slice(before).map((request) => Buffer.from(request.raw)), [small, other]);
	client.socket.destroy();
	await client.closed;
});

test("a literal over the reader's cap is refused without buffering it", async () => {
	const client = openClient();
	await client.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	const before = appends.length;
	client.send("C1 APPEND INBOX {2000000}\r\n");
	const answer = await client.waitFor("* BAD Literal too large\r\n");
	assert.equal(answer, "* BAD Literal too large\r\n");
	await client.closed;
	assert.equal(appends.length, before);
});
