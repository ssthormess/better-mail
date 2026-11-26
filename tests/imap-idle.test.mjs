import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-imap-idle-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

/**
 * IDLE (RFC 2177), in two tiers. The protocol half pins what a command line answers — the `+ idling`
 * continuation, the mailbox and count it hands the socket, the selected-state refusal and the CAPABILITY token.
 * The socket half runs a real TCP connection, because the parts that matter there have no pure form: DONE has to
 * be read off the wire while the IDLE is open, the poll has to push EXISTS only when the total moves, the
 * 29-minute stop has to end the IDLE, and a closed or finished IDLE must leave no poll timer behind. The
 * inactivity timeout is shortened in one test to prove an idling connection is exempt from it.
 */
await build({
	stdin: {
		contents: `
			export {
				parseImapCommand,
				dispatchImapCommand,
				isImapIdleDone,
				idleBusyResponse,
				IMAP_IDLE_POLL_MS,
				IMAP_IDLE_MAX_MS,
			} from "./server/runtime/imap-protocol.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-idle-protocol-entry.ts",
	},
	outfile: join(outDir, "protocol.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

await build({
	stdin: {
		contents: `export { startImapListener } from "./server/runtime/imap.ts";`,
		resolveDir: root,
		sourcefile: "imap-idle-listener-entry.ts",
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
		name: "imap-idle-mocks",
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
				export function imapMailboxBackend() { return globalThis.__backend; }
			`);
		},
	}],
});

const { parseImapCommand, dispatchImapCommand, isImapIdleDone, idleBusyResponse, IMAP_IDLE_POLL_MS, IMAP_IDLE_MAX_MS } =
	await import(pathToFileURL(join(outDir, "protocol.mjs")).href);
const { startImapListener } = await import(pathToFileURL(join(outDir, "listener.mjs")).href);

const ENTRY = { name: "INBOX", ref: "mbx1~inbox", mailboxId: "mbx1", role: "inbox", folderId: null, selectable: true };
const TRASH = { name: "Trash", ref: "mbx1~trash", mailboxId: "mbx1", role: "trash", folderId: null, selectable: true };
const SELECTED = { state: "selected", selected: { name: "INBOX", ref: "mbx1~inbox", uidValidity: 42, readOnly: true } };
const protocolBackend = {
	list: async () => [ENTRY],
	counts: async () => ({ messages: 3, unseen: 1 }),
};
const run = (line, session = SELECTED, backend = protocolBackend) =>
	dispatchImapCommand(session, parseImapCommand(line), backend);

globalThis.__auth = { userId: "u1", email: "alice@example.test", user: { id: "u1", role: "member" }, mailboxIds: null, keyId: "k1", keyKind: "app", scopes: [] };
/**
 * The one mailbox the socket tests read. Every test resets it; `counts` counts how often a count was read (SELECT,
 * APPEND's re-count and each IDLE poll), which is how a test sees whether polling stopped.
 */
const mailbox = {
	messages: 3,
	unseen: 1,
	counts: 0,
	missing: false,
	/** false models a revoked shared grant: `idleCounts` answers `null`, so the IDLE must end without a count. */
	readable: true,
	/** A promise the next count waits on, so a test can close the socket while a count is still in flight. */
	pendingCount: null,
};
globalThis.__backend = {
	list: async () => (mailbox.missing ? [] : [ENTRY, TRASH]),
	counts: async () => {
		mailbox.counts += 1;
		if (mailbox.pendingCount) await mailbox.pendingCount.promise;
		return { messages: mailbox.messages, unseen: mailbox.unseen };
	},
	// The socket layer's per-tick read: the same count, gated on current access.
	idleCounts: async () => {
		mailbox.counts += 1;
		if (!mailbox.readable) return null;
		return { messages: mailbox.messages, unseen: mailbox.unseen };
	},
	messages: async () => Array.from({ length: mailbox.messages }, (_, index) => ({
		id: `msg${index + 1}`,
		uid: index + 1,
		read: false,
		starred: false,
		trashed: false,
		draft: false,
		outbound: false,
	})),
	move: async (source, ids) => {
		mailbox.messages -= ids.length;
		return { result: "ok", changed: ids };
	},
	append: async () => {
		mailbox.messages += 1;
		return "ok";
	},
};
const resetMailbox = () => {
	mailbox.messages = 3;
	mailbox.unseen = 1;
	mailbox.counts = 0;
	mailbox.missing = false;
	mailbox.readable = true;
	mailbox.pendingCount = null;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client that keeps everything it has read, so a response can be awaited before the next command is sent.
 * `received()` is what has not been consumed by a `waitFor` yet, which is how a test asserts that nothing was
 * pushed.
 */
function openClient(port) {
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
	return { send: (data) => socket.write(data), waitFor, closed, socket, received: () => received };
}

/** A listener with test-sized timers: the defaults are the contract, the shortened ones are how the timers are seen. */
async function startListener(t, options = {}) {
	const server = startImapListener({}, {
		port: 0,
		tls: null,
		idlePollMs: 20,
		idleMaxMs: 30_000,
		inactivityTimeoutMs: 1_000,
		...options,
	});
	t.after(() => server.close());
	await new Promise((resolve) => server.once("listening", resolve));
	return server.address().port;
}

/** LOGIN and SELECT INBOX, with the tag prefix the test uses, leaving nothing unread on the client. */
async function selectInbox(client, prefix) {
	await client.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	client.send(`${prefix}1 LOGIN alice secret\r\n`);
	await client.waitFor(`${prefix}1 OK LOGIN completed\r\n`);
	client.send(`${prefix}2 SELECT INBOX\r\n`);
	await client.waitFor(`${prefix}2 OK [READ-ONLY] SELECT completed\r\n`);
}

test("IDLE is advertised, and only a selected session may enter it", async () => {
	assert.equal(
		(await run("A CAPABILITY")).response,
		"* CAPABILITY IMAP4rev1 MOVE IDLE ID APPENDLIMIT=10485760\r\nA OK CAPABILITY completed\r\n",
	);
	// RFC 2177 extends the selected-state command set, so an unselected session gets the same BAD its siblings do.
	assert.equal((await run("A IDLE", { state: "authenticated", selected: null })).response, "A BAD No mailbox selected\r\n");
	assert.equal((await run("A IDLE", { state: "selected", selected: null })).response, "A BAD No mailbox selected\r\n");
	assert.equal((await run("A IDLE now")).response, "A BAD IDLE takes no arguments\r\n");
	// No backend at all: the dispatcher must refuse rather than accept an IDLE it cannot poll.
	assert.equal((await dispatchImapCommand(SELECTED, parseImapCommand("A IDLE"))).response, "A NO Mailbox data unavailable\r\n");
	const gone = { list: async () => [], counts: async () => ({ messages: 0, unseen: 0 }) };
	assert.equal((await run("A IDLE", SELECTED, gone)).response, "A NO No such mailbox\r\n");
});

test("an accepted IDLE answers + idling and hands the socket the mailbox and its baseline", async () => {
	const action = await run("A7 IDLE");
	assert.equal(action.response, "+ idling\r\n");
	assert.deepEqual(action.idle, { tag: "A7", entry: ENTRY, messages: 3 });
	// Idling changes nothing about the session: it is still selected, and the tagged OK is not written here.
	assert.equal(action.state, undefined);
	assert.equal(action.selected, undefined);
});

test("SELECT reports the count it answered so an IDLE can tell whether mail arrived since", async () => {
	const action = await run("A9 SELECT INBOX", { state: "authenticated", selected: null });
	assert.equal(action.state, "selected");
	assert.equal(action.messages, 3);
	assert.match(action.response, /^\* 3 EXISTS\r\n/);
});

test("DONE is recognised in any case, and only DONE is valid while idling", () => {
	for (const line of ["DONE", "done", "DoNe", " DONE "]) assert.equal(isImapIdleDone(line), true, line);
	for (const line of ["", "NODONE", "DONE2", "IDLE DONE"]) assert.equal(isImapIdleDone(line), false, line);
	// A tagged BAD names the command the client sent; a bare line has no tag to answer.
	assert.equal(idleBusyResponse(parseImapCommand("B3 NOOP")), "B3 BAD Only DONE ends IDLE\r\n");
	assert.equal(idleBusyResponse(null), "* BAD Only DONE ends IDLE\r\n");
	// The tuning is part of the contract: one count query per connection every 15 s, and a 29-minute re-arm.
	assert.equal(IMAP_IDLE_POLL_MS, 15_000);
	assert.equal(IMAP_IDLE_MAX_MS, 29 * 60_000);
});

test("IDLE pushes EXISTS when the total changes, stays quiet for UNSEEN, and DONE ends it", async (t) => {
	resetMailbox();
	const port = await startListener(t);
	const client = openClient(port);
	await selectInbox(client, "B");
	client.send("B3 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");

	// A new message is the count moving, which is the one signal this model can push honestly.
	mailbox.messages = 5;
	assert.equal(await client.waitFor("* 5 EXISTS\r\n"), "* 5 EXISTS\r\n");

	// UNSEEN alone is a flag change: EXISTS is the total and a FETCH update is a later slice, so nothing is sent.
	mailbox.unseen = 7;
	await delay(80);
	assert.equal(client.received(), "");

	client.send("DONE\r\n");
	assert.equal(await client.waitFor("B3 OK Idle terminated\r\n"), "B3 OK Idle terminated\r\n");
	// The poll stops with the IDLE, so no count is read once it is over.
	await delay(80);
	const afterDone = mailbox.counts;
	await delay(120);
	assert.equal(mailbox.counts, afterDone);

	// The session is still selected and still knows the mailbox, so a selected-state verb answers normally.
	client.send("B5 STATUS INBOX (MESSAGES)\r\n");
	assert.match(await client.waitFor("B5 OK STATUS completed\r\n"), /^\* STATUS INBOX \(MESSAGES 5\)\r\n/);

	// And nothing is pushed on a session that is no longer idling.
	mailbox.messages = 6;
	await delay(80);
	assert.equal(client.received(), "");
	client.socket.destroy();
	await client.closed;
});

test("DONE is case-insensitive and leaves the session selected", async (t) => {
	resetMailbox();
	const port = await startListener(t);
	const client = openClient(port);
	await selectInbox(client, "C");
	client.send("C3 IDLE\r\n");
	await client.waitFor("+ idling\r\n");
	client.send("dOnE\r\n");
	assert.equal(await client.waitFor("C3 OK Idle terminated\r\n"), "C3 OK Idle terminated\r\n");
	client.send("C4 NOOP\r\n");
	assert.equal(await client.waitFor("C4 OK NOOP completed\r\n"), "C4 OK NOOP completed\r\n");
	client.socket.destroy();
	await client.closed;
});

test("a command sent while idling is a tagged BAD, and the IDLE carries on", async (t) => {
	resetMailbox();
	const port = await startListener(t);
	const client = openClient(port);
	await selectInbox(client, "D");
	client.send("D3 IDLE\r\n");
	await client.waitFor("+ idling\r\n");
	// RFC 2177 defines no client command other than DONE here: answer the one that was sent and stay idling.
	client.send("D4 NOOP\r\n");
	assert.equal(await client.waitFor("D4 BAD Only DONE ends IDLE\r\n"), "D4 BAD Only DONE ends IDLE\r\n");
	mailbox.messages = 9;
	assert.equal(await client.waitFor("* 9 EXISTS\r\n"), "* 9 EXISTS\r\n");
	client.send("DONE\r\n");
	assert.equal(await client.waitFor("D3 OK Idle terminated\r\n"), "D3 OK Idle terminated\r\n");
	client.socket.destroy();
	await client.closed;
});

test("DONE pipelined straight behind IDLE ends it instead of being queued as a command", async (t) => {
	resetMailbox();
	const port = await startListener(t);
	const client = openClient(port);
	await selectInbox(client, "E");
	// One write, DONE already on the wire before this connection has answered the IDLE: the line has to wait for
	// the IDLE to be accepted and then end it, not go through the command queue as an unknown verb.
	client.send("E3 IDLE\r\nDONE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	assert.equal(await client.waitFor("E3 OK Idle terminated\r\n"), "E3 OK Idle terminated\r\n");
	client.send("E4 NOOP\r\n");
	assert.equal(await client.waitFor("E4 OK NOOP completed\r\n"), "E4 OK NOOP completed\r\n");
	client.socket.destroy();
	await client.closed;
});

test("an IDLE announces mail that arrived between SELECT and IDLE", async (t) => {
	resetMailbox();
	// A poll long enough that the immediate EXISTS cannot be mistaken for one.
	const port = await startListener(t, { idlePollMs: 2_000 });
	const client = openClient(port);
	await selectInbox(client, "F");
	mailbox.messages = 4;
	client.send("F3 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	// The client was last told 3, so the count it missed between the two commands is announced before it waits.
	assert.equal(await client.waitFor("* 4 EXISTS\r\n"), "* 4 EXISTS\r\n");
	client.send("DONE\r\n");
	await client.waitFor("F3 OK Idle terminated\r\n");
	client.socket.destroy();
	await client.closed;
});

test("the re-arm window ends the IDLE with a tagged OK, and the client may IDLE again", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idleMaxMs: 120, idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "G");
	client.send("G3 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	// No DONE: the server ends the IDLE itself, which is what keeps a silent connection from sitting past the
	// 30-minute window a NAT or proxy may drop it in.
	assert.equal(await client.waitFor("G3 OK Idle terminated\r\n"), "G3 OK Idle terminated\r\n");
	await delay(60);
	const afterStop = mailbox.counts;
	await delay(120);
	assert.equal(mailbox.counts, afterStop);
	// Re-arming is the client's next IDLE, on the same selected session.
	client.send("G4 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	client.send("DONE\r\n");
	assert.equal(await client.waitFor("G4 OK Idle terminated\r\n"), "G4 OK Idle terminated\r\n");
	client.socket.destroy();
	await client.closed;
});

test("an idling connection is exempt from the inactivity timeout; a silent one is not", async (t) => {
	resetMailbox();
	const port = await startListener(t, { inactivityTimeoutMs: 120, idlePollMs: 40 });
	// First the timer itself: a connection that sends nothing after the greeting is closed, which is the behaviour
	// an IDLE has to be exempt from.
	const quiet = openClient(port);
	await quiet.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	await quiet.closed;

	// Then an IDLE that stays silent for ten times that timeout: without the exemption the poll would be writing to
	// a socket the inactivity timer had already destroyed.
	const idling = openClient(port);
	await selectInbox(idling, "H");
	idling.send("H3 IDLE\r\n");
	await idling.waitFor("+ idling\r\n");
	await delay(1_200);
	assert.equal(idling.socket.destroyed, false);
	mailbox.messages = 12;
	assert.equal(await idling.waitFor("* 12 EXISTS\r\n"), "* 12 EXISTS\r\n");
	idling.send("DONE\r\n");
	await idling.waitFor("H3 OK Idle terminated\r\n");
	// Ending the IDLE re-arms the ordinary contract: the same connection is now closed for staying silent.
	await idling.closed;
});

test("a closed idling connection leaves no poll timer behind", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "I");
	client.send("I3 IDLE\r\n");
	await client.waitFor("+ idling\r\n");
	// Let the poll prove it is running before the connection goes away.
	await delay(80);
	assert.ok(mailbox.counts > 0);
	client.socket.destroy();
	await client.closed;
	await delay(80);
	const afterClose = mailbox.counts;
	// No poll may outlive the socket: a timer that kept reading counts for a gone client is the leak this pins.
	await delay(160);
	assert.equal(mailbox.counts, afterClose);
	// The listener itself is unaffected.
	const other = openClient(port);
	await other.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	other.send("I4 NOOP\r\n");
	assert.equal(await other.waitFor("I4 OK NOOP completed\r\n"), "I4 OK NOOP completed\r\n");
	other.socket.destroy();
	await other.closed;
});

test("a refused IDLE starts no poll and pushes nothing", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await client.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	client.send("J1 LOGIN alice secret\r\n");
	await client.waitFor("J1 OK LOGIN completed\r\n");
	const before = mailbox.counts;
	client.send("J2 IDLE\r\n");
	assert.equal(await client.waitFor("J2 BAD No mailbox selected\r\n"), "J2 BAD No mailbox selected\r\n");
	mailbox.messages = 99;
	await delay(120);
	assert.equal(mailbox.counts, before);
	assert.equal(client.received(), "");
	client.socket.destroy();
	await client.closed;
});

test("an IDLE ends without a count when the mailbox is no longer readable", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "L");
	client.send("L3 IDLE\r\n");
	await client.waitFor("+ idling\r\n");
	// A shared grant was revoked (or the mailbox disabled): the per-tick gate now refuses the read, so the IDLE
	// ends — with the tagged OK the deadline and DONE use — and no EXISTS for the mailbox is written.
	mailbox.readable = false;
	const answer = await client.waitFor("L3 OK Idle terminated\r\n");
	assert.doesNotMatch(answer, /EXISTS/);
	await delay(80);
	assert.equal(client.received(), "");
	// The poll stopped with the IDLE, so a gone grant costs no further queries.
	const afterEnd = mailbox.counts;
	await delay(120);
	assert.equal(mailbox.counts, afterEnd);
	client.socket.destroy();
	await client.closed;
});

test("an IDLE never pushes a total below the one the client was told", async (t) => {
	resetMailbox();
	mailbox.messages = 7;
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "M");
	client.send("M3 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");

	// An external delete takes 7 to 6. RFC 3501 §5.2 lets only an EXPUNGE lower the selected count, and this
	// positional model cannot name the rows an EXPUNGE would, so the shrink is not pushed at all: the client's
	// cached view of the mailbox is left stale rather than corrected with an illegal reduction.
	mailbox.messages = 6;
	await delay(120);
	assert.equal(client.received(), "");

	// The mailbox grows past the baseline: the total is now one the client has never been told, so it is pushed.
	mailbox.messages = 8;
	assert.equal(await client.waitFor("* 8 EXISTS\r\n"), "* 8 EXISTS\r\n");

	// A later drop is suppressed again, which keeps the whole EXISTS stream non-decreasing.
	mailbox.messages = 7;
	await delay(120);
	assert.equal(client.received(), "");
	client.send("DONE\r\n");
	assert.equal(await client.waitFor("M3 OK Idle terminated\r\n"), "M3 OK Idle terminated\r\n");
	client.socket.destroy();
	await client.closed;
});

test("a session MOVE lowers the baseline, so a following IDLE does not re-report the pre-move total", async (t) => {
	resetMailbox();
	mailbox.messages = 7;
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "N");

	// MOVE answers with the EXPUNGEs, which is how the client learns the mailbox shrank: after `* 2 EXPUNGE` and
	// `* 1 EXPUNGE` its total is 5, and the IDLE baseline has to be 5 too, not the 7 SELECT reported.
	client.send("N3 MOVE 1:2 Trash\r\n");
	const moved = await client.waitFor("N3 OK MOVE completed\r\n");
	assert.match(moved, /^\* 2 EXPUNGE\r\n\* 1 EXPUNGE\r\nN3 OK MOVE completed\r\n$/);
	assert.equal(mailbox.messages, 5);

	client.send("N4 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	// Nothing is pushed: re-announcing 5 would be an EXISTS the client already knows, and 7 is below the baseline.
	await delay(120);
	assert.equal(client.received(), "");

	// And mail after the move is still announced against the moved total.
	mailbox.messages = 6;
	assert.equal(await client.waitFor("* 6 EXISTS\r\n"), "* 6 EXISTS\r\n");
	client.send("DONE\r\n");
	assert.equal(await client.waitFor("N4 OK Idle terminated\r\n"), "N4 OK Idle terminated\r\n");
	client.socket.destroy();
	await client.closed;
});

test("a stored APPEND into the selected mailbox lowers the next IDLE's redundant report", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "O");
	const raw = Buffer.from("From: a@b.test\r\nSubject: One\r\n\r\nhi\r\n", "utf8");
	// LITERAL+ keeps the test one write for the payload; APPEND itself is not what this test pins.
	client.send(`O3 APPEND INBOX {${raw.length}+}\r\n`);
	client.send(raw);
	client.send("\r\n");
	await client.waitFor("O3 OK APPEND completed\r\n");
	assert.equal(mailbox.messages, 4);

	// The append re-read the selected mailbox's count, so the client's 4 and the baseline agree: IDLE says nothing.
	client.send("O4 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	await delay(120);
	assert.equal(client.received(), "");
	client.send("DONE\r\n");
	assert.equal(await client.waitFor("O4 OK Idle terminated\r\n"), "O4 OK Idle terminated\r\n");
	client.socket.destroy();
	await client.closed;
});

test("a literal-bearing line is refused before literal mode while an IDLE is open or being answered", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "P");

	// Pipelined behind an unanswered IDLE (the prelude window): the literal marker must not turn into a
	// continuation and the payload must never be framed as commands.
	const payload = Buffer.from("From: a@b.test\r\nSubject: Queued\r\n\r\nhi\r\n", "utf8");
	client.send(`P3 IDLE\r\nP4 APPEND INBOX {${payload.length}}\r\n`);
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");
	assert.equal(await client.waitFor("P4 BAD Only DONE ends IDLE\r\n"), "P4 BAD Only DONE ends IDLE\r\n");
	// The refusal is not a continuation, and no APPEND was attempted.
	assert.doesNotMatch(client.received(), /Ready for literal data/);
	assert.equal(mailbox.messages, 3);

	// A synchronizing literal got no continuation, so the bytes the client never owed are framed as its next
	// command line — which is how a pipelined DONE still ends the IDLE.
	client.send(`P5 APPEND INBOX {${payload.length}}\r\nDONE\r\n`);
	assert.equal(await client.waitFor("P5 BAD Only DONE ends IDLE\r\n"), "P5 BAD Only DONE ends IDLE\r\n");
	assert.equal(await client.waitFor("P3 OK Idle terminated\r\n"), "P3 OK Idle terminated\r\n");
	assert.equal(mailbox.messages, 3);
	client.socket.destroy();
	await client.closed;
});

test("an in-flight LITERAL+ payload is drained while idling, so its DONE-like bytes are not commands", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "Q");
	client.send("Q3 IDLE\r\n");
	assert.equal(await client.waitFor("+ idling\r\n"), "+ idling\r\n");

	// `{4+}` sends the payload without waiting, and here the payload is exactly the text "DONE": the framer has to
	// drain the declared bytes and the CRLF that ends the command line, or that text would be read as a command and
	// silently end the IDLE.
	client.send("Q4 APPEND INBOX {4+}\r\nDONE\r\n");
	assert.equal(await client.waitFor("Q4 BAD Only DONE ends IDLE\r\n"), "Q4 BAD Only DONE ends IDLE\r\n");
	await delay(80);
	// Still idling: the drained DONE was payload, not a termination.
	assert.doesNotMatch(client.received(), /Idle terminated/);
	client.send("DONE\r\n");
	assert.equal(await client.waitFor("Q3 OK Idle terminated\r\n"), "Q3 OK Idle terminated\r\n");
	assert.equal(mailbox.messages, 3);
	client.socket.destroy();
	await client.closed;
});

test("a socket that closes while its IDLE count is pending arms no timers", async (t) => {
	resetMailbox();
	const port = await startListener(t, { idlePollMs: 20 });
	const client = openClient(port);
	await selectInbox(client, "R");
	// Park the count the IDLE command resolves before `+ idling`, so the socket can close mid-command.
	let release;
	mailbox.pendingCount = { promise: new Promise((resolve) => { release = resolve; }) };
	client.send("R3 IDLE\r\n");
	await delay(40);
	client.socket.destroy();
	await client.closed;
	// Let the server observe the close first: this is the late-dispatch case, where the IDLE's count resolves after
	// the connection is already gone.
	await delay(120);
	release();
	mailbox.pendingCount = null;
	await delay(40);
	const afterClose = mailbox.counts;
	await delay(160);
	// No poll and no deadline were installed on the dead connection: a late IDLE must not start its machinery.
	assert.equal(mailbox.counts, afterClose);
	// The listener itself is unaffected.
	const other = openClient(port);
	await other.waitFor("* OK Mailflare IMAP4rev1 server ready\r\n");
	other.send("R4 NOOP\r\n");
	assert.equal(await other.waitFor("R4 OK NOOP completed\r\n"), "R4 OK NOOP completed\r\n");
	other.socket.destroy();
	await other.closed;
});
