import type { SystemRole } from "@/lib/jmap/types";
import { LIMITS } from "@/lib/jmap/constants";
import { resolveImapFolderTarget, type ImapFolderTargetResolution } from "./imap-mailboxes";

/**
 * `not-authenticated` → `authenticated` → `selected` → `logged-out`. The selected
 * phase carries the mailbox the session is reading, so CLOSE/UNSELECT can drop
 * back to `authenticated` without guessing.
 */
export type ImapSessionState = "not-authenticated" | "authenticated" | "selected" | "logged-out";
/**
 * One parsed command line. `literal` is the message bytes the socket layer read after a `{n}`
 * marker: the literal is binary, so it never travels through the quoted-string tokenizer.
 */
export type ImapCommand = { tag: string; verb: string; args: string[]; literal?: ArrayBuffer };

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

/**
 * One message as FETCH reports it: the flag columns plus its provisional positional
 * UID. Sequence number and UID are both the 1-based position in the selected
 * mailbox, ordered by arrival, so `uid` is what the backend assigned the row.
 */
export type ImapMessageEntry = {
	/** `messages.id` — what a MOVE has to act on; the UID is only a position. */
	id: string;
	uid: number;
	/** `messages.read` — directed mail has no read toggle, hence `outbound` below. */
	read: boolean;
	starred: boolean;
	/** `messages.trashed_at` is set: the row sits in Trash or Spam. */
	trashed: boolean;
	/** `messages.status = 'draft'` — the same marker JMAP uses for the `$draft` keyword. */
	draft: boolean;
	/** `messages.direction = 'outbound'` — always seen, matching the UNSEEN counter. */
	outbound: boolean;
};

/**
 * One folder a write command acts on: the mailbox that owns it, the row for an existing
 * folder, and the folder name inside that mailbox's IMAP namespace. The protocol resolves
 * an IMAP name to this shape; the backend owns authorisation and storage.
 */
export type ImapFolderTarget = {
	mailboxId: string;
	/** Set for DELETE/RENAME, which address a row; CREATE makes a new one. */
	folderId?: string;
	/** The name as a `folders` row stores it (`Receipts`), never namespaced. */
	name: string;
	/** The full IMAP name including any `addr/` namespace prefix — what LIST shows. */
	imapName: string;
};

/**
 * `denied` deliberately covers both "this account may not manage the mailbox" and "not
 * accessible at all", so a caller cannot tell a read-only share from a foreign mailbox.
 */
export type ImapFolderWriteResult = "ok" | "denied" | "exists" | "missing";

/** What APPEND hands the backend: where the message goes, the flags it arrived with, and the bytes. */
export type ImapAppendRequest = {
	entry: ImapMailboxEntry;
	/** Canonical flags (`\\Seen`), only the ones the bridge can store. */
	flags: string[];
	/** RFC 3501 §6.3.11 internal date, null when the client sent none. */
	internalDate: Date | null;
	raw: ArrayBuffer;
};

/**
 * `duplicate` is a stored message whose Message-ID is already in the mailbox: the append did not add a
 * row. `invalid` is a payload the import seam could not store (unparsable MIME, rejected attachment).
 */
export type ImapAppendResult = "ok" | "duplicate" | "denied" | "invalid";

/** `denied` needs full_access; `cross-mailbox` is a move between two of the account's mailboxes. */
export type ImapMoveOutcome =
	| { result: "ok"; changed: string[] }
	| { result: "denied" }
	| { result: "missing" }
	| { result: "cross-mailbox" }
	| { result: "invalid"; description: string };

/** What the dispatcher needs from the database. Kept behind an interface so the protocol stays pure and testable. */
export type ImapMailboxBackend = {
	list(): Promise<ImapMailboxEntry[]>;
	counts(entry: ImapMailboxEntry): Promise<ImapMailboxCounts>;
	/** Every message of the selected mailbox in sequence order, so index + 1 is the UID. */
	messages(selected: ImapSelectedMailbox): Promise<ImapMessageEntry[]>;
	/** CREATE: a new folder row. `denied` unless the account can manage the mailbox. */
	createFolder(target: ImapFolderTarget): Promise<ImapFolderWriteResult>;
	/** DELETE: removes the row; its messages unfile through the `set null` foreign key. */
	deleteFolder(target: ImapFolderTarget): Promise<ImapFolderWriteResult>;
	/** RENAME: renames in place, so message folder refs stay valid (the id does not change). */
	renameFolder(target: ImapFolderTarget, name: string): Promise<ImapFolderWriteResult>;
	/** APPEND: stores the literal as a real message in that mailbox, through the import seam. */
	append(request: ImapAppendRequest): Promise<ImapAppendResult>;
	/** MOVE: re-files the rows, reusing the JMAP membership rule; returns the ids that changed. */
	move(source: ImapMailboxEntry, messageIds: string[], destination: ImapMailboxEntry): Promise<ImapMoveOutcome>;
};

export type ImapAction = {
	response: string;
	state?: ImapSessionState;
	selected?: ImapSelectedMailbox | null;
	login?: { username: string; password: string };
};

/** The one hierarchy delimiter Mailflare's IMAP names use. */
export const IMAP_DELIMITER = "/";

/**
 * The flags the bridge reports, in the order SELECT advertises them. `\Answered` is
 * deliberately absent: Mailflare stores no answered/replied state, so advertising it
 * would claim a flag that is always absent and — with no STORE yet — can never be set.
 * `\Recent` is absent for the same reason, which is why SELECT answers `0 RECENT`.
 */
export const IMAP_FLAGS = ["\\Seen", "\\Flagged", "\\Draft", "\\Deleted"] as const;

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
	if (verb === "CAPABILITY") return { response: `* CAPABILITY IMAP4rev1 MOVE ID\r\n${tag} OK CAPABILITY completed\r\n` };
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
	// RFC 3501 §6.3 places CREATE/DELETE/RENAME in both the authenticated and the selected
	// state, so they run here rather than behind a selection.
	if (verb === "CREATE") return createCommand(tag, args, backend);
	if (verb === "DELETE") return deleteCommand(tag, args, session, backend);
	if (verb === "RENAME") return renameCommand(tag, args, session, backend);
	// APPEND is legal in both the authenticated and the selected state (RFC 3501 §6.3.11), and it names
	// its own destination, so it does not read the selection.
	if (verb === "APPEND") return appendCommand(tag, command, backend);
	if (verb === "MOVE") return moveCommand(tag, false, args, session, backend);
	if (verb === "FETCH") return fetchCommand(tag, false, args, session, backend);
	if (verb === "UID") return uidCommand(tag, args, session, backend);
	if (verb === "UNSELECT" || verb === "CLOSE") {
		if (args.length > 0) return { response: `${tag} BAD ${verb} takes no arguments\r\n` };
		if (!session.selected) return { response: `${tag} NO No mailbox selected\r\n` };
		// Read-only this slice, so CLOSE has nothing to expunge and stays a plain deselect.
		return { response: `${tag} OK ${verb} completed\r\n`, state: "authenticated", selected: null };
	}
	return { response: `${tag} NO Not implemented yet\r\n` };
}

/**
 * RFC 3501 §5.1.3 modified UTF-7: printable ASCII stands for itself except `&`, which
 * shifts into a run of modified BASE64 (UTF-16BE, no padding, `,` for `/`) terminated by
 * `-`; a literal `&` is `&-`. Every non-ASCII name a client creates or lists goes through
 * this codec, which is why LIST output and CREATE input agree on the same bytes.
 */
const MODIFIED_UTF7_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

export function encodeModifiedUtf7(value: string): string {
	let encoded = "";
	let pending: number[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		let bits = 0;
		let length = 0;
		let run = "";
		for (const byte of pending) {
			bits = (bits << 8) | byte;
			length += 8;
			while (length >= 6) {
				length -= 6;
				run += MODIFIED_UTF7_ALPHABET[(bits >> length) & 0x3f];
			}
		}
		// Leftover bits are padded with zeroes; modified BASE64 carries no `=` padding.
		if (length > 0) run += MODIFIED_UTF7_ALPHABET[(bits << (6 - length)) & 0x3f];
		encoded += `&${run}-`;
		pending = [];
	};
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "&") {
			flush();
			encoded += "&-";
		} else if (code >= 0x20 && code <= 0x7e) {
			flush();
			encoded += char;
		} else {
			// Code units, not code points: UTF-16BE is what the RFC encodes, so a surrogate pair stays two units.
			for (let index = 0; index < char.length; index++) {
				const unit = char.charCodeAt(index);
				pending.push((unit >> 8) & 0xff, unit & 0xff);
			}
		}
	}
	flush();
	return encoded;
}

/** Decode a client-supplied mailbox name. `null` means the name is not valid modified UTF-7, which is a protocol error. */
export function decodeModifiedUtf7(value: string): string | null {
	let decoded = "";
	let index = 0;
	while (index < value.length) {
		if (value[index] !== "&") {
			decoded += value[index++];
			continue;
		}
		const end = value.indexOf("-", index + 1);
		// A `&` with no closing `-` is a truncated shift sequence.
		if (end < 0) return null;
		const run = value.slice(index + 1, end);
		if (run === "") {
			decoded += "&";
			index = end + 1;
			continue;
		}
		const bytes = decodeModifiedBase64(run);
		if (!bytes || bytes.length % 2 !== 0) return null;
		for (let offset = 0; offset < bytes.length; offset += 2) {
			const unit = (bytes[offset] << 8) | bytes[offset + 1];
			// NUL cannot appear in a mailbox name, so a run that decodes to one is malformed rather than a name.
			if (unit === 0) return null;
			decoded += String.fromCharCode(unit);
		}
		index = end + 1;
	}
	return decoded;
}

function decodeModifiedBase64(value: string): number[] | null {
	const bytes: number[] = [];
	let bits = 0;
	let length = 0;
	for (const char of value) {
		const digit = MODIFIED_UTF7_ALPHABET.indexOf(char);
		if (digit < 0) return null;
		bits = (bits << 6) | digit;
		length += 6;
		if (length >= 8) {
			length -= 8;
			bytes.push((bits >> length) & 0xff);
		}
	}
	// A single leftover character can only carry 4 meaningful bits, and they must be zero padding.
	if (length === 6) return null;
	if (length > 0 && (bits & ((1 << length) - 1)) !== 0) return null;
	return bytes;
}

export function loginResult(tag: string, authenticated: boolean): ImapAction {
	return authenticated
		? { response: `${tag} OK LOGIN completed\r\n`, state: "authenticated" }
		: { response: `${tag} NO Authentication failed\r\n` };
}

async function listCommand(tag: string, verb: "LIST" | "LSUB", args: string[], backend?: ImapMailboxBackend): Promise<ImapAction> {
	if (args.length !== 2) return { response: `${tag} BAD ${verb} needs a reference and a mailbox pattern\r\n` };
	const reference = decodeModifiedUtf7(args[0]);
	const pattern = decodeModifiedUtf7(args[1]);
	if (reference === null || pattern === null) return { response: `${tag} BAD ${verb} mailbox names must be modified UTF-7\r\n` };
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
	if (!backend) return { ...mailboxUnavailable(tag), state: "authenticated", selected: null };
	const mailboxName = decodeModifiedUtf7(args[0]);
	if (mailboxName === null) return { response: `${tag} BAD ${verb} mailbox name must be modified UTF-7\r\n`, state: "authenticated", selected: null };
	const entry = resolveImapMailbox(await backend.list(), mailboxName);
	// Nonexistent and inaccessible names answer the same "no", so a session cannot probe for mailboxes it may not read.
	// RFC 3501 §6.3.2: a SELECT/EXAMINE that fails to open the mailbox must not leave an older selection in place.
	if (!entry) return { response: `${tag} NO No such mailbox\r\n`, state: "authenticated", selected: null };
	const counts = await backend.counts(entry);
	// The bridge is read-only in this slice: APPEND/STORE arrive later, so both SELECT and EXAMINE answer READ-ONLY.
	const selected: ImapSelectedMailbox = { name: entry.name, ref: entry.ref, uidValidity: imapUidValidity(entry.ref), readOnly: true };
	const lines = [
		`* ${counts.messages} EXISTS`,
		`* 0 RECENT`,
		`* FLAGS (${IMAP_FLAGS.join(" ")})`,
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
	const mailboxName = decodeModifiedUtf7(args[0]);
	if (mailboxName === null) return { response: `${tag} BAD STATUS mailbox name must be modified UTF-7\r\n` };
	const entry = resolveImapMailbox(await backend.list(), mailboxName);
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

/**
 * CREATE/DELETE/RENAME decide on four things in the same order, so all three verbs answer
 * alike: the name has to parse as modified UTF-7, it has to land in a mailbox namespace this
 * session can see (which is also where an inaccessible mailbox is indistinguishable from a
 * nonexistent one), role mailboxes and `addr/` namespace parents are not folders, and the
 * backend has the last word on whether the account may manage that mailbox.
 */
async function createCommand(tag: string, args: string[], backend?: ImapMailboxBackend): Promise<ImapAction> {
	if (args.length !== 1) return { response: `${tag} BAD CREATE needs one mailbox name\r\n` };
	const name = decodeModifiedUtf7(args[0]);
	if (name === null) return { response: `${tag} BAD CREATE mailbox name must be modified UTF-7\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const resolution = resolveImapFolderTarget(await backend.list(), name);
	const refusal = folderWriteRefusal(tag, "CREATE", resolution);
	if (refusal) return { response: refusal };
	const target = resolution.kind === "new" ? resolution.target : null;
	if (!target) return { response: `${tag} NO No such mailbox\r\n` };
	const result = await backend.createFolder(target);
	// The new folder needs no `* LIST` here: RFC 3501 §6.3.3 makes an untagged LIST optional, and the
	// next LIST reads the folder table fresh, so the client's own LIST finds it.
	return { response: `${tag} ${folderWriteResponse(result, "CREATE")}\r\n` };
}

async function deleteCommand(tag: string, args: string[], session: ImapSession, backend?: ImapMailboxBackend): Promise<ImapAction> {
	if (args.length !== 1) return { response: `${tag} BAD DELETE needs one mailbox name\r\n` };
	const name = decodeModifiedUtf7(args[0]);
	if (name === null) return { response: `${tag} BAD DELETE mailbox name must be modified UTF-7\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const resolution = resolveImapFolderTarget(await backend.list(), name);
	const refusal = missingFolderRefusal(tag, "DELETE", resolution);
	if (refusal) return { response: refusal };
	const target = resolution.kind === "folder" ? resolution.target : null;
	if (!target) return { response: `${tag} NO No such mailbox\r\n` };
	const result = await backend.deleteFolder(target);
	const response = `${tag} ${folderWriteResponse(result, "DELETE")}\r\n`;
	// A deleted mailbox cannot stay selected: dropping the session back to authenticated is the
	// honest answer, and FETCH on a deleted ref would otherwise silently report an empty mailbox.
	if (result === "ok" && resolution.kind === "folder" && session.selected?.ref === resolution.entry.ref) {
		return { response, state: "authenticated", selected: null };
	}
	return { response };
}

async function renameCommand(tag: string, args: string[], session: ImapSession, backend?: ImapMailboxBackend): Promise<ImapAction> {
	if (args.length !== 2) return { response: `${tag} BAD RENAME needs an old and a new mailbox name\r\n` };
	const from = decodeModifiedUtf7(args[0]);
	const to = decodeModifiedUtf7(args[1]);
	if (from === null || to === null) return { response: `${tag} BAD RENAME mailbox names must be modified UTF-7\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const entries = await backend.list();
	const resolution = resolveImapFolderTarget(entries, from);
	// The old name has to be an existing folder; "already exists" is only a refusal for the new name below.
	const refusal = missingFolderRefusal(tag, "RENAME", resolution);
	if (refusal) return { response: refusal };
	if (resolution.kind !== "folder") return { response: `${tag} NO No such mailbox\r\n` };
	// A rename that only changes case is a no-op in this model: names are unique case-insensitively in LIST.
	if (from.trim().toLowerCase() === to.trim().toLowerCase()) return { response: `${tag} OK RENAME completed\r\n` };
	const renamed = resolveImapFolderTarget(entries, to);
	const target = renamed.kind === "new" ? renamed.target : null;
	if (!target) return { response: folderWriteRefusal(tag, "RENAME", renamed) ?? `${tag} NO No such mailbox\r\n` };
	// Folders belong to one mailbox: moving one across mailboxes would attach another mailbox's messages to it.
	if (target.mailboxId !== resolution.target.mailboxId) return { response: `${tag} NO RENAME cannot move a folder to another mailbox\r\n` };
	const result = await backend.renameFolder(resolution.target, target.name);
	const response = `${tag} ${folderWriteResponse(result, "RENAME")}\r\n`;
	// The selection keeps its ref (the id never changes), so only its reported name moves.
	if (result === "ok" && session.selected?.ref === resolution.entry.ref) {
		return { response, selected: { ...session.selected, name: target.imapName } };
	}
	return { response };
}

/** The shared NO for a folder write: role mailboxes, namespace parents and malformed names never reach the backend. */
function folderWriteRefusal(tag: string, verb: "CREATE" | "RENAME", resolution: ImapFolderTargetResolution): string | null {
	if (resolution.kind === "invalid") return `${tag} NO ${resolution.message}\r\n`;
	if (resolution.kind === "role" || resolution.kind === "parent") return `${tag} NO ${verb} is not allowed on this mailbox\r\n`;
	if (resolution.kind === "folder") return `${tag} NO Mailbox already exists\r\n`;
	return null;
}

/** The same NO for DELETE/RENAME's old name, where an existing folder is what the verb needs rather than what it refuses. */
function missingFolderRefusal(tag: string, verb: "DELETE" | "RENAME", resolution: ImapFolderTargetResolution): string | null {
	if (resolution.kind === "invalid") return `${tag} NO ${resolution.message}\r\n`;
	if (resolution.kind === "role" || resolution.kind === "parent") return `${tag} NO ${verb} is not allowed on this mailbox\r\n`;
	if (resolution.kind === "new") return `${tag} NO No such mailbox\r\n`;
	return null;
}

/** Map the backend's verdict to the underscore-tagged response line; `denied` says no more than an unknown name. */
function folderWriteResponse(result: ImapFolderWriteResult, verb: "CREATE" | "DELETE" | "RENAME"): string {
	if (result === "ok") return `OK ${verb} completed`;
	if (result === "exists") return "NO Mailbox already exists";
	return "NO No such mailbox";
}

/**
 * The flags APPEND can store, in canonical spelling. Anything else (`\\Recent`, a keyword, a client's
 * `$label`) has no column in this model, so it is dropped rather than echoed back as a flag nothing holds.
 */
const APPEND_FLAGS: Record<string, string> = {
	"\\SEEN": "\\Seen",
	"\\FLAGGED": "\\Flagged",
	"\\DRAFT": "\\Draft",
	"\\DELETED": "\\Deleted",
};

/**
 * APPEND: `APPEND <mailbox> [(<flags>)] [<date-time>] {<n>}` + literal bytes.
 *
 * The bytes go through the same import seam as REST and JMAP (`importMessageToMailbox`), so placement,
 * threading, attachments, FTS and the change journal are written once, by the code that already owns them.
 * The flag list is not a set of columns: `\\Draft` and `\\Deleted` are the Drafts/Trash mailboxes here
 * (status, and the trigger-maintained `trashed_at`), so a flag that contradicts the destination cannot be
 * stored honestly. Marking INBOX mail `\\Draft` would make it a private draft of the appender, and `\\Deleted`
 * would move it out of the mailbox the client appended it to, so both answer NO and write nothing.
 *
 * An internal date older than the mailbox's newest message files the row earlier in the sequence, and the UID
 * of everything after it moves up by one: this bridge's UIDs are the arrival position (see `mailboxMessages`),
 * so APPEND is the one command that can renumber. Nothing here advertises CONDSTORE/QRESYNC, and the client
 * sees the new message through its next SELECT/STATUS rather than an untagged EXISTS.
 */
async function appendCommand(tag: string, command: ImapCommand, backend?: ImapMailboxBackend): Promise<ImapAction> {
	const parsed = parseImapAppendArguments(command.args);
	if ("error" in parsed) return { response: `${tag} BAD APPEND ${parsed.error}\r\n` };
	const name = decodeModifiedUtf7(parsed.name);
	if (name === null) return { response: `${tag} BAD APPEND mailbox name must be modified UTF-7\r\n` };
	const raw = command.literal;
	if (!raw || raw.byteLength === 0) return { response: `${tag} BAD APPEND needs a message literal\r\n` };
	// The socket layer already refuses a literal over its own buffer cap; this is the protocol-level cap,
	// the same one JMAP uploads use, so a client cannot store a message no other protocol would accept.
	if (raw.byteLength > LIMITS.maxSizeUpload) return { response: `${tag} NO Message is larger than ${LIMITS.maxSizeUpload} bytes\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const entry = resolveImapMailbox(await backend.list(), name);
	// RFC 3501 §6.3.11: a name that is not there yet is what TRYCREATE is for.
	if (!entry) return { response: `${tag} NO [TRYCREATE] No such mailbox\r\n` };
	const flags = parsed.flags.map((flag) => APPEND_FLAGS[flag.toUpperCase()]).filter((flag): flag is string => Boolean(flag));
	if (flags.includes("\\Draft") && entry.role !== "drafts") return { response: `${tag} NO Drafts mail is only appendable to the Drafts mailbox\r\n` };
	if (flags.includes("\\Deleted") && entry.role !== "trash") return { response: `${tag} NO Deleted mail is only appendable to the Trash mailbox\r\n` };
	const result = await backend.append({ entry, flags, internalDate: parsed.internalDate, raw });
	return { response: `${tag} ${appendResponse(result)}\r\n` };
}

/** The flags decide their own columns, so APPEND never falls back to the import hints for read/starred. */
function appendResponse(result: ImapAppendResult): string {
	// A duplicate Message-ID is still "the message is in the mailbox", so the append succeeded: what it did not
	// do is add a second row (the seam may still add \\Seen/\\Flagged to the row it found). RFC 3501 has no
	// response code for that — APPENDUID is UIDPLUS, which this server does not advertise — and a NO would make
	// a client retry a message that is already stored.
	if (result === "ok" || result === "duplicate") return "OK APPEND completed";
	if (result === "invalid") return "NO Message could not be stored";
	// `denied` is the canManage gate. The mailbox is in this session's own catalogue (LIST and SELECT already
	// name it), so unlike CREATE's "NO No such mailbox" there is nothing left for the refusal to hide.
	return "NO APPEND is not allowed on this mailbox";
}

/**
 * MOVE (RFC 6851): `MOVE <seq-set> <mailbox>` and `UID MOVE`, over the selected mailbox. The row keeps its
 * id and its raw MIME; only `folder_id`/`status` (and, through them, `trashed_at`) change, so this is the same
 * membership update JMAP `Email/set` makes, reused from `targetFromMailboxIds`.
 *
 * The bridge has no per-message flags to rewrite in place, so a move between two of the account's mailboxes is
 * refused exactly as JMAP refuses it — `messages.mailbox_id` is part of every reader's scope (folders, the
 * change journal, the counts) and the model has no notion of a message belonging to two mailboxes.
 */
async function moveCommand(
	tag: string,
	uid: boolean,
	args: string[],
	session: ImapSession,
	backend?: ImapMailboxBackend,
): Promise<ImapAction> {
	const label = uid ? "UID MOVE" : "MOVE";
	if (!session.selected) return { response: `${tag} BAD No mailbox selected\r\n` };
	if (args.length !== 2) return { response: `${tag} BAD ${label} needs a sequence set and a mailbox name\r\n` };
	if (!backend) return mailboxUnavailable(tag);
	const destinationName = decodeModifiedUtf7(args[1]);
	if (destinationName === null) return { response: `${tag} BAD ${label} mailbox name must be modified UTF-7\r\n` };
	const entries = await backend.list();
	const source = entries.find((entry) => entry.selectable && entry.ref === session.selected!.ref) ?? null;
	if (!source) return { response: `${tag} NO No such mailbox\r\n` };
	const destination = resolveImapMailbox(entries, destinationName);
	if (!destination) return { response: `${tag} NO [TRYCREATE] No such mailbox\r\n` };
	const messages = await backend.messages(session.selected);
	if (messages.length === 0) return { response: `${tag} BAD Mailbox is empty\r\n` };
	const sequenceNumbers = parseImapSequenceSet(args[0], messages.length);
	if (!sequenceNumbers) return { response: `${tag} BAD ${label} sequence set is malformed or out of range\r\n` };
	const ids = sequenceNumbers.map((sequence) => messages[sequence - 1].id);
	const outcome = await backend.move(source, ids, destination);
	if (outcome.result === "denied") return { response: `${tag} NO ${label} is not allowed on this mailbox\r\n` };
	if (outcome.result === "cross-mailbox") return { response: `${tag} NO ${label} cannot move mail between mailboxes\r\n` };
	if (outcome.result === "invalid") return { response: `${tag} NO ${outcome.description}\r\n` };
	if (outcome.result === "missing") return { response: `${tag} NO No such mailbox\r\n` };
	// The messages left the selected mailbox, so the client's view is corrected with EXPUNGE responses (RFC 3501
	// §7.4.1 wants them in descending order) before the tagged OK, which is what RFC 6851 asks MOVE to do in
	// place of the STORE+EXPUNGE a client would otherwise issue itself. A move that changed nothing (same
	// mailbox, same folder) has nothing to expunge.
	const changed = new Set(outcome.changed);
	const expunged = sequenceNumbers.filter((sequence, index) => changed.has(ids[index])).sort((left, right) => right - left);
	const untagged = expunged.map((sequence) => `* ${sequence} EXPUNGE\r\n`).join("");
	return { response: `${untagged}${tag} OK ${label} completed\r\n` };
}

/**
 * APPEND's arguments, once the literal is out of the way: `mailbox [(flags)] [date-time]`. The flag list is
 * split on spaces by the command-line tokenizer, so `(\\Seen \\Flagged)` arrives as several tokens and is
 * reassembled here; the date-time is a quoted string but is also accepted unquoted, joined back together.
 */
export function parseImapAppendArguments(
	args: string[],
): { name: string; flags: string[]; internalDate: Date | null } | { error: string } {
	if (args.length === 0) return { error: "needs a mailbox name" };
	const name = args[0];
	const rest = args.slice(1);
	const flags: string[] = [];
	if (rest.length > 0 && rest[0].startsWith("(")) {
		const end = rest.findIndex((token) => token.endsWith(")"));
		if (end < 0) return { error: "flag list is not closed" };
		const joined = rest.slice(0, end + 1).join(" ");
		if (!/^\([^()]*\)$/.test(joined)) return { error: "flag list is malformed" };
		flags.push(...joined.slice(1, -1).split(/\s+/).filter(Boolean));
		rest.splice(0, end + 1);
	}
	if (rest.length === 0) return { name, flags, internalDate: null };
	const internalDate = parseImapDateTime(rest.join(" "));
	if (!internalDate) return { error: "date-time is malformed" };
	return { name, flags, internalDate };
}

const IMAP_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * RFC 3501 §9 date-time (`dd-Mon-yyyy HH:mm:ss +ZZZZ`), the internal date APPEND may carry. `created_at`
 * takes a timestamp, so the value the client states becomes the message's arrival time (and therefore its
 * position in the UID order) instead of being dropped.
 */
export function parseImapDateTime(value: string): Date | null {
	const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const month = IMAP_MONTHS.indexOf(match[2].toLowerCase());
	const day = Number(match[1]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (month < 0 || hour > 23 || minute > 59 || second > 60) return null;
	const utc = Date.UTC(Number(match[3]), month, day, hour, minute, second);
	const date = new Date(utc);
	// Date.UTC rolls 31-Feb over into March instead of refusing it, so the calendar fields are checked back.
	if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
	const offset = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === "-" ? -1 : 1);
	return new Date(utc - offset * 60_000);
}

/**
 * UID commands share FETCH's sequence model: UIDs are positional, so `UID FETCH` is
 * FETCH with the UID echoed back and `UID MOVE` is MOVE over the same numbers. Every other UID
 * subcommand (STORE, COPY, SEARCH, EXPUNGE) is a later slice and answers the same honest NO as
 * any unimplemented verb.
 */
async function uidCommand(tag: string, args: string[], session: ImapSession, backend?: ImapMailboxBackend): Promise<ImapAction> {
	const subcommand = args[0]?.toUpperCase();
	if (!subcommand) return { response: `${tag} BAD UID needs a subcommand\r\n` };
	if (subcommand === "MOVE") return moveCommand(tag, true, args.slice(1), session, backend);
	if (subcommand !== "FETCH") return { response: `${tag} NO Not implemented yet\r\n` };
	return fetchCommand(tag, true, args.slice(1), session, backend);
}

/**
 * FETCH and UID FETCH over the selected mailbox. Only FLAGS and UID are served: the
 * bridge has no message bodies to hand out yet, so ENVELOPE/BODY/RFC822 answer BAD
 * instead of inventing an answer.
 */
async function fetchCommand(
	tag: string,
	uid: boolean,
	args: string[],
	session: ImapSession,
	backend?: ImapMailboxBackend,
): Promise<ImapAction> {
	const label = uid ? "UID FETCH" : "FETCH";
	// FETCH is only legal in selected state, so this is a protocol error (BAD) rather than UNSELECT's NO.
	if (!session.selected) return { response: `${tag} BAD No mailbox selected\r\n` };
	if (args.length < 2) return { response: `${tag} BAD ${label} needs a sequence set and data items\r\n` };
	const items = parseImapFetchItems(args.slice(1));
	if (!items) return { response: `${tag} BAD ${label} data items must be a parenthesized list\r\n` };
	if (items.some((item) => item !== "FLAGS" && item !== "UID")) {
		return { response: `${tag} BAD ${label} supports FLAGS and UID only\r\n` };
	}
	if (!backend) return mailboxUnavailable(tag);
	const messages = await backend.messages(session.selected);
	if (messages.length === 0) return { response: `${tag} BAD Mailbox is empty\r\n` };
	const sequenceNumbers = parseImapSequenceSet(args[0], messages.length);
	if (!sequenceNumbers) return { response: `${tag} BAD ${label} sequence set is malformed or out of range\r\n` };
	// RFC 3501 §6.4.8: a UID FETCH reports the UID whether or not the client asked for it.
	const wanted = [...new Set(uid ? [...items, "UID"] : items)];
	const lines = sequenceNumbers.map((sequence) => {
		const message = messages[sequence - 1];
		const parts = wanted.map((item) => (item === "UID" ? `UID ${message.uid}` : `FLAGS (${imapMessageFlags(message).join(" ")})`));
		return `* ${sequence} FETCH (${parts.join(" ")})`;
	});
	return { response: `${lines.join("\r\n")}\r\n${tag} OK ${label} completed\r\n` };
}

/** Flags for one message, in the order SELECT advertises them. */
export function imapMessageFlags(message: ImapMessageEntry): string[] {
	const flags: string[] = [];
	// Outbound mail is seen: it has no `read` toggle and the UNSEEN counter only counts inbound rows.
	if (message.read || message.outbound) flags.push("\\Seen");
	if (message.starred) flags.push("\\Flagged");
	if (message.draft) flags.push("\\Draft");
	if (message.trashed) flags.push("\\Deleted");
	return flags;
}

/**
 * `(FLAGS UID)` arrives as `["(FLAGS", "UID)"]` because the command line is split on
 * spaces. A bare `FLAGS` or `FLAGS UID` is accepted too, as RFC 3501 allows.
 */
export function parseImapFetchItems(args: string[]): string[] | null {
	const joined = args.join(" ").trim();
	if (!joined) return null;
	const parenthesized = /^\(([^()]*)\)$/.exec(joined);
	if (!parenthesized) {
		if (/[()]/.test(joined)) return null;
		const bare = joined.split(/\s+/).filter(Boolean).map((item) => item.toUpperCase());
		return bare.length > 0 ? bare : null;
	}
	const items = parenthesized[1].split(/\s+/).filter(Boolean).map((item) => item.toUpperCase());
	return items.length > 0 ? items : null;
}

/**
 * An IMAP sequence set: `n`, `n:m`, `n:*`, `*`, comma-separated, in either direction
 * (`5:3` is `3:5`, per RFC 3501's seq-range). `last` is the mailbox's message count,
 * which is also its highest UID. Anything outside `1..last` is refused rather than
 * silently ignored: with positional UIDs an out-of-range number means the client's
 * view of the mailbox is stale.
 */
export function parseImapSequenceSet(value: string, last: number): number[] | null {
	if (last < 1) return null;
	const wanted = new Set<number>();
	for (const part of value.split(",")) {
		if (!part) return null;
		const [left, right, extra] = part.split(":");
		if (extra !== undefined) return null;
		const from = imapSequencePoint(left, last);
		const to = right === undefined ? from : imapSequencePoint(right, last);
		if (from === null || to === null) return null;
		for (let number = Math.min(from, to); number <= Math.max(from, to); number++) wanted.add(number);
	}
	return [...wanted].sort((left, right) => left - right);
}

function imapSequencePoint(token: string, last: number): number | null {
	if (token === "*") return last;
	if (!/^\d+$/.test(token)) return null;
	const value = Number(token);
	if (!Number.isSafeInteger(value) || value < 1 || value > last) return null;
	return value;
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

/** An atom-safe name is emitted bare; anything with a delimiter-hostile, quote or control character is quoted.
 *  The name is modified-UTF-7 encoded first, so non-ASCII folders reach the client in the same
 *  encoding CREATE will decode them from. */
export function formatImapName(name: string): string {
	const encoded = encodeModifiedUtf7(name);
	const atomSafe = encoded.length > 0 && !/[\s(){%*"\\\]]/.test(encoded) && !/[\u0000-\u001f\u007f]/.test(encoded);
	return atomSafe ? encoded : quoteImapLiteral(encoded);
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
