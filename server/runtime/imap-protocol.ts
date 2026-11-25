import type { SystemRole } from "@/lib/jmap/types";

/**
 * `not-authenticated` → `authenticated` → `selected` → `logged-out`. The selected
 * phase carries the mailbox the session is reading, so CLOSE/UNSELECT can drop
 * back to `authenticated` without guessing.
 */
export type ImapSessionState = "not-authenticated" | "authenticated" | "selected" | "logged-out";
export type ImapCommand = { tag: string; verb: string; args: string[] };

/** The mailbox a session has selected. `ref` is the stable JMAP mailbox reference it resolved to. */
export type ImapSelectedMailbox = { name: string; ref: string; uidValidity: number; readOnly: boolean };
export type ImapSession = { state: ImapSessionState; selected: ImapSelectedMailbox | null };

/**
 * One IMAP-visible mailbox name. `\Noselect` namespace parents exist only to hold
 * children, so they carry no `ref` and cannot be selected.
 */
export type ImapMailboxEntry = {
	name: string;
	ref: string;
	mailboxId: string;
	role: SystemRole | null;
	folderId: string | null;
	selectable: boolean;
};
export type ImapMailboxCounts = { messages: number; unseen: number };

/** What the dispatcher needs from the database. Kept behind an interface so the protocol stays pure and testable. */
export type ImapMailboxBackend = {
	list(): Promise<ImapMailboxEntry[]>;
	counts(entry: ImapMailboxEntry): Promise<ImapMailboxCounts>;
};

export type ImapAction = {
	response: string;
	state?: ImapSessionState;
	selected?: ImapSelectedMailbox | null;
	login?: { username: string; password: string };
};

/** The one hierarchy delimiter Mailflare's IMAP names use. */
export const IMAP_DELIMITER = "/";

/** Parse an IMAP command line. Quoted strings support backslash escapes; literals are supplied by the socket layer as quoted values. */
export function quoteImapLiteral(value: string): string {
	return `"${value.replace(/["\\\\]/g, (char) => `\\${char}`)}"`;
}

export function parseImapCommand(line: string): ImapCommand | null {
	const tokens: string[] = [];
	let i = 0;
	while (i < line.length) {
		while (line[i] === " " || line[i] === "\t") i++;
		if (i >= line.length) break;
		if (line[i] === '"') {
			i++;
			let value = "";
			let closed = false;
			while (i < line.length) {
				const char = line[i++];
				if (char === '"') { closed = true; break; }
				if (char === "\\") {
					if (i >= line.length) return null;
					value += line[i++];
				} else value += char;
			}
			if (!closed || (i < line.length && line[i] !== " " && line[i] !== "\t")) return null;
			tokens.push(value);
		} else {
			const start = i;
			while (i < line.length && line[i] !== " " && line[i] !== "\t") i++;
			tokens.push(line.slice(start, i));
		}
	}
	if (tokens.length < 2 || !/^[^\s{}]+$/.test(tokens[0])) return null;
	return { tag: tokens[0], verb: tokens[1].toUpperCase(), args: tokens.slice(2) };
}

/** Accept the bare state the old dispatcher took, so callers can hand over either shape. */
export function asImapSession(session: ImapSession | ImapSessionState): ImapSession {
	return typeof session === "string" ? { state: session, selected: null } : session;
}

/**
 * Produce one protocol action. LOGIN is an event for the server to authenticate
 * asynchronously; the mailbox verbs read through the supplied backend.
 */
export async function dispatchImapCommand(
	sessionInput: ImapSession | ImapSessionState,
	command: ImapCommand,
	backend?: ImapMailboxBackend,
): Promise<ImapAction> {
	const session = asImapSession(sessionInput);
	const { tag, verb, args } = command;
	if (verb === "CAPABILITY") return { response: `* CAPABILITY IMAP4rev1 ID\r\n${tag} OK CAPABILITY completed\r\n` };
	if (verb === "NOOP") return { response: `${tag} OK NOOP completed\r\n` };
	if (verb === "LOGOUT") return { response: `* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`, state: "logged-out", selected: null };
	if (verb === "ID") return { response: `* ID (\"name\" \"Mailflare\")\r\n${tag} OK ID completed\r\n` };
	if (verb === "LOGIN") {
		if (session.state !== "not-authenticated") return { response: `${tag} BAD LOGIN only valid before authentication\r\n` };
		if (args.length !== 2) return { response: `${tag} BAD LOGIN requires username and password\r\n` };
		return { response: "", login: { username: args[0], password: args[1] } };
	}
	if (session.state === "not-authenticated") return { response: `${tag} BAD Authenticate first\r\n` };
	if (session.state === "logged-out") return { response: `${tag} BAD Connection is closing\r\n` };

	if (verb === "LIST" || verb === "LSUB") return listCommand(tag, verb, args, backend);
	if (verb === "SELECT" || verb === "EXAMINE") return selectCommand(tag, verb, args, backend);
	if (verb === "STATUS") return statusCommand(tag, args, backend);
	if (verb === "UNSELECT" || verb === "CLOSE") {
		if (args.length > 0) return { response: `${tag} BAD ${verb} takes no arguments\r\n` };
		if (!session.selected) return { response: `${tag} NO No mailbox selected\r\n` };
		// Read-only this slice, so CLOSE has nothing to expunge and stays a plain deselect.
		return { response: `${tag} OK ${verb} completed\r\n`, state: "authenticated", selected: null };
	}
	return { response: `${tag} NO Not implemented yet\r\n` };
}

export function loginResult(tag: string, authenticated: boolean): ImapAction {
	return authenticated
		? { response: `${tag} OK LOGIN completed\r\n`, state: "authenticated" }
		: { response: `${tag} NO Authentication failed\r\n` };
}

async function listCommand(tag: string, verb: "LIST" | "LSUB", args: string[], backend?: ImapMailboxBackend): Promise<ImapAction> {
	if (args.length !== 2) return { response: `${tag} BAD ${verb} needs a reference and a mailbox pattern\r\n` };
	const [reference, pattern] = args;
	// RFC 3501 §6.3.8: an empty mailbox pattern asks for the hierarchy delimiter only.
	if (pattern === "") return { response: `* ${verb} (\\Noselect) "${IMAP_DELIMITER}" ""\r\n${tag} OK ${verb} completed\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const entries = await backend.list();
	const matches = selectImapListEntries(entries, reference, pattern);
	const listed = matches.map((entry) => `${formatImapListEntry(verb, entry)}\r\n`).join("");
	return { response: `${listed}${tag} OK ${verb} completed\r\n` };
}

async function selectCommand(
	tag: string,
	verb: "SELECT" | "EXAMINE",
	args: string[],
	backend?: ImapMailboxBackend,
): Promise<ImapAction> {
	if (args.length !== 1) return { response: `${tag} BAD ${verb} needs one mailbox name\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const entry = resolveImapMailbox(await backend.list(), args[0]);
	// Nonexistent and inaccessible names answer the same "no", so a session cannot probe for mailboxes it may not read.
	if (!entry) return { response: `${tag} NO No such mailbox\r\n` };
	const counts = await backend.counts(entry);
	// The bridge is read-only in this slice: APPEND/STORE arrive later, so both SELECT and EXAMINE answer READ-ONLY.
	const selected: ImapSelectedMailbox = { name: entry.name, ref: entry.ref, uidValidity: imapUidValidity(entry.ref), readOnly: true };
	const lines = [
		`* ${counts.messages} EXISTS`,
		`* 0 RECENT`,
		`* FLAGS (\\Answered \\Flagged \\Draft \\Seen \\Deleted)`,
		`* OK [UIDVALIDITY ${selected.uidValidity}] UIDs valid`,
		`* OK [UIDNEXT ${counts.messages + 1}] Predicted next UID`,
		`* OK [PERMANENTFLAGS ()] Read-only mailbox`,
		`${tag} OK [READ-ONLY] ${verb} completed`,
	];
	return { response: `${lines.join("\r\n")}\r\n`, state: "selected", selected };
}

async function statusCommand(tag: string, args: string[], backend?: ImapMailboxBackend): Promise<ImapAction> {
	if (args.length < 2) return { response: `${tag} BAD STATUS needs a mailbox name and a data item list\r\n` };
	const items = parseImapStatusItems(args.slice(1));
	if (!items) return { response: `${tag} BAD STATUS data items must be a parenthesized list\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const entry = resolveImapMailbox(await backend.list(), args[0]);
	if (!entry) return { response: `${tag} NO No such mailbox\r\n` };
	const counts = await backend.counts(entry);
	const values: string[] = [];
	for (const item of items) {
		// Unknown data items are ignored rather than refused, the way RFC 3501 §6.3.10 leaves new items to extensions.
		if (item === "MESSAGES") values.push("MESSAGES", String(counts.messages));
		else if (item === "UNSEEN") values.push("UNSEEN", String(counts.unseen));
		else if (item === "RECENT") values.push("RECENT", "0");
		else if (item === "UIDNEXT") values.push("UIDNEXT", String(counts.messages + 1));
		else if (item === "UIDVALIDITY") values.push("UIDVALIDITY", String(imapUidValidity(entry.ref)));
	}
	if (values.length === 0) return { response: `${tag} BAD STATUS supports MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN\r\n` };
	return { response: `* STATUS ${formatImapName(entry.name)} (${values.join(" ")})\r\n${tag} OK STATUS completed\r\n` };
}

function mailboxUnavailable(tag: string): ImapAction {
	return { response: `${tag} NO Mailbox data unavailable\r\n` };
}

/**
 * `(MESSAGES UNSEEN)` arrives as the argument tail `["(MESSAGES", "UNSEEN)"]`
 * because the command line is split on spaces. RFC 3501 requires the parentheses.
 */
export function parseImapStatusItems(args: string[]): string[] | null {
	const parenthesized = /^\(([^()]*)\)$/.exec(args.join(" ").trim());
	if (!parenthesized) return null;
	const items = parenthesized[1].split(/\s+/).filter(Boolean).map((item) => item.toUpperCase());
	return items.length > 0 ? items : null;
}

/** An atom-safe name is emitted bare; anything with a delimiter-hostile, quote or control character is quoted. */
export function formatImapName(name: string): string {
	const atomSafe = name.length > 0 && !/[\s(){%*"\\\]]/.test(name) && !/[\u0000-\u001f\u007f]/.test(name);
	return atomSafe ? name : quoteImapLiteral(name);
}

function imapListAttributes(entry: ImapMailboxEntry): string {
	return entry.selectable ? "\\HasNoChildren" : "\\HasChildren \\Noselect";
}

export function formatImapListEntry(verb: "LIST" | "LSUB", entry: ImapMailboxEntry): string {
	return `* ${verb} (${imapListAttributes(entry)}) "${IMAP_DELIMITER}" ${formatImapName(entry.name)}`;
}

/**
 * RFC 3501 list wildcards: `*` crosses the hierarchy delimiter, `%` stops at it.
 * Matching is case-insensitive, which is lenient for everything and required for
 * INBOX; a session's own names are unique case-insensitively anyway.
 */
export function matchImapPattern(pattern: string, name: string): boolean {
	let source = "^";
	for (const char of pattern.toLowerCase()) {
		if (char === "*") source += ".*";
		else if (char === "%") source += `[^${IMAP_DELIMITER}]*`;
		else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${source}$`, "s").test(name.toLowerCase());
}

/**
 * Apply a LIST/LSUB reference and pattern to the session's entries. A reference
 * that ends with the delimiter scopes the pattern to that namespace; anything
 * else falls back to matching the pattern against every name, so a client never
 * loses folders to a reference this server cannot interpret.
 */
export function selectImapListEntries(entries: ImapMailboxEntry[], reference: string, pattern: string): ImapMailboxEntry[] {
	if (!reference) return entries.filter((entry) => matchImapPattern(pattern, entry.name));
	if (!reference.endsWith(IMAP_DELIMITER)) return entries.filter((entry) => matchImapPattern(pattern, entry.name));
	const prefix = reference.toLowerCase();
	return entries
		.filter((entry) => entry.name.toLowerCase().startsWith(prefix))
		.filter((entry) => matchImapPattern(pattern, entry.name.slice(reference.length)));
}

/** Resolve a SELECT/EXAMINE/STATUS name. INBOX is case-insensitive; a mailbox reference is accepted as a name too. */
export function resolveImapMailbox(entries: ImapMailboxEntry[], name: string): ImapMailboxEntry | null {
	const wanted = name.trim();
	if (!wanted) return null;
	const candidates = entries.filter((entry) => entry.selectable);
	const exact = candidates.find((entry) => entry.name === wanted);
	if (exact) return exact;
	const lower = wanted.toLowerCase();
	if (lower === "inbox") {
		const inbox = candidates.find((entry) => entry.name === "INBOX");
		if (inbox) return inbox;
	}
	const insensitive = candidates.find((entry) => entry.name.toLowerCase() === lower);
	if (insensitive) return insensitive;
	// Names are the public interface, but a JMAP reference (e.g. `mbx~inbox`) is unambiguous.
	return candidates.find((entry) => entry.ref === wanted) ?? null;
}

/**
 * A stable UIDVALIDITY per mailbox. Mailflare messages have no numeric id, so the
 * number is an FNV-1a hash of the reference: same ref, same value, every session.
 */
export function imapUidValidity(ref: string): number {
	let hash = 2166136261;
	for (let index = 0; index < ref.length; index++) {
		hash ^= ref.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return ((hash >>> 0) % 2147483646) + 1;
}
