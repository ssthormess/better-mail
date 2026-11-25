import { and, asc, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messages } from "@/db/schema";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { draftsVisibleTo, logMessageHidden, privateDraftForStatus } from "@/lib/email/draft-access";
import { newId } from "@/lib/ids";
import { getImportMessageUserId } from "@/lib/import/destination";
import type { ImportDestination, ImportSystemSection } from "@/lib/import/destination-types";
import { describeImportError, importMessageToMailbox } from "@/lib/import/service";
import { targetFromMailboxIds } from "@/lib/jmap/emails";
import { encodeMailboxRef } from "@/lib/jmap/ids";
import type { MailboxRef, SystemRole } from "@/lib/jmap/types";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { planImapMailboxEntries } from "./imap-mailboxes";
import { buildImapSearchConditions } from "./imap-search-sql";
import type { ImapSearchCriteria } from "./imap-search";
import type {
	ImapAppendRequest,
	ImapAppendResult,
	ImapFolderTarget,
	ImapFolderWriteResult,
	ImapMailboxBackend,
	ImapMailboxCounts,
	ImapMailboxEntry,
	ImapMessageEntry,
	ImapMoveOutcome,
	ImapSelectedMailbox,
} from "./imap-protocol";

/** Statuses each role folder counts, mirroring the JMAP mailbox counts (sent folds in queued and failed). */
const ROLE_STATUSES: Record<SystemRole, string[]> = {
	inbox: ["received"],
	sent: ["sent", "queued", "failed"],
	drafts: ["draft"],
	archive: ["archived"],
	junk: ["spam"],
	trash: ["trash"],
};

/** Role folder → the import section REST and JMAP import place mail with, so all three agree on a row's columns. */
const ROLE_SECTIONS: Record<SystemRole, ImportSystemSection> = {
	inbox: "inbox",
	sent: "sent",
	drafts: "drafts",
	archive: "archived",
	junk: "spam",
	trash: "trash",
};

/** Every IMAP-visible name for the authenticated account, parents included. */
export async function listImapMailboxEntries(db: AppDatabase, auth: ApiAuthResult): Promise<ImapMailboxEntry[]> {
	const accessible = (await listAccessibleMailboxes(db, auth.user)).filter((mailbox) => !auth.mailboxIds || auth.mailboxIds.includes(mailbox.id));
	if (accessible.length === 0) return [];
	const rows = await db
		.select({ id: folders.id, mailboxId: folders.mailboxId, name: folders.name })
		.from(folders)
		.where(inArray(folders.mailboxId, accessible.map((mailbox) => mailbox.id)));
	const foldersByMailbox = new Map<string, Array<{ id: string; name: string }>>();
	for (const row of rows) {
		const list = foldersByMailbox.get(row.mailboxId) ?? [];
		list.push({ id: row.id, name: row.name });
		foldersByMailbox.set(row.mailboxId, list);
	}
	return planImapMailboxEntries(accessible, foldersByMailbox);
}

/**
 * MESSAGES/UNSEEN for one folder, using the same predicates as the JMAP mailbox
 * counts: role folders are a status over unfiled messages, custom folders are a
 * folder id, and INBOX drops messages whose snooze has not expired yet.
 */
async function mailboxCounts(db: AppDatabase, auth: ApiAuthResult, entry: ImapMailboxEntry): Promise<ImapMailboxCounts> {
	const conditions = mailboxConditions(auth, entry);
	if (!conditions) return { messages: 0, unseen: 0 };
	const [row] = await db
		.select({
			messages: count(),
			unseen: sql<number>`sum(case when not ${messages.read} and ${messages.direction} = 'inbound' then 1 else 0 end)`,
		})
		.from(messages)
		.where(and(...conditions));
	return { messages: Number(row?.messages ?? 0), unseen: Number(row?.unseen ?? 0) };
}

/** What a folder contains, shared by the counters and FETCH so EXISTS and the listed messages agree. */
function mailboxConditions(auth: ApiAuthResult, entry: ImapMailboxEntry): SQL[] | null {
	const conditions: SQL[] = [eq(messages.mailboxId, entry.mailboxId), draftsVisibleTo(auth.userId)];
	if (entry.folderId) {
		conditions.push(eq(messages.folderId, entry.folderId));
	} else if (entry.role) {
		conditions.push(isNull(messages.folderId));
		conditions.push(inArray(messages.status, ROLE_STATUSES[entry.role]));
		if (entry.role === "inbox") conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
	} else {
		return null;
	}
	return conditions;
}

/**
 * The whole selected mailbox in sequence order. UIDs are positional, so the offset is
 * the number: ordering is `created_at` then `id` (the tiebreak the paged list queries
 * use), which is appended-only when old mail arrives late rather than shifting every
 * message. Reading the full list is provisional, the same way UIDNEXT is: the mailbox
 * has no per-message index yet, so paging would still have to count the rows before it.
 */
async function mailboxMessages(db: AppDatabase, auth: ApiAuthResult, entry: ImapMailboxEntry): Promise<ImapMessageEntry[]> {
	const conditions = mailboxConditions(auth, entry);
	if (!conditions) return [];
	const rows = await db
		.select({
			id: messages.id,
			read: messages.read,
			starred: messages.starred,
			trashedAt: messages.trashedAt,
			status: messages.status,
			direction: messages.direction,
		})
		.from(messages)
		.where(and(...conditions))
		.orderBy(asc(messages.createdAt), asc(messages.id));
	return rows.map((row, index) => ({
		id: row.id,
		uid: index + 1,
		read: row.read,
		starred: row.starred,
		trashed: row.trashedAt !== null,
		draft: row.status === "draft",
		outbound: row.direction === "outbound",
	}));
}

/** The selected mailbox's message ids in sequence order: the numbering UIDs and `* SEARCH` numbers come from. */
async function mailboxMessageIds(db: AppDatabase, auth: ApiAuthResult, entry: ImapMailboxEntry): Promise<string[]> {
	const conditions = mailboxConditions(auth, entry);
	if (!conditions) return [];
	const rows = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(...conditions))
		.orderBy(asc(messages.createdAt), asc(messages.id));
	return rows.map((row) => row.id);
}

/**
 * SEARCH. The criteria tree becomes a column predicate (`buildImapSearchConditions`), so the mailbox's rows that
 * match are found by the database rather than by walking every message; the positional criteria (a sequence set,
 * `UID`) resolve through the same ordered id list that numbers the mailbox, which is why one query can answer
 * the whole tree. The numbers are then the positions of the matching rows in that order — the same numbers FETCH
 * echoes as UIDs.
 */
async function searchMessages(
	db: AppDatabase,
	auth: ApiAuthResult,
	entry: ImapMailboxEntry,
	criteria: ImapSearchCriteria,
): Promise<number[]> {
	const conditions = mailboxConditions(auth, entry);
	if (!conditions) return [];
	const ids = await mailboxMessageIds(db, auth, entry);
	if (ids.length === 0) return [];
	const rows = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(...conditions, buildImapSearchConditions(criteria, ids)));
	const matched = new Set(rows.map((row) => row.id));
	return ids.flatMap((id, index) => (matched.has(id) ? [index + 1] : []));
}

/** Resolve a selection back to its catalogue entry: the ref is unique per mailbox name. */
function entryForSelected(catalogue: ImapMailboxEntry[], selected: ImapSelectedMailbox): ImapMailboxEntry | null {
	return catalogue.find((entry) => entry.selectable && entry.ref === selected.ref) ?? null;
}

/**
 * The access level a folder write is checked against. Same gate as `getMailboxFolderAccess`:
 * the mailbox has to be readable at all, and an API key that is scoped to a set of mailboxes
 * must not write outside that set. The caller decides whether `canManage` is required.
 */
async function folderWriteAccess(db: AppDatabase, auth: ApiAuthResult, mailboxId: string) {
	if (auth.mailboxIds && !auth.mailboxIds.includes(mailboxId)) return null;
	const access = await getMailboxAccessLevel(db, auth.user, mailboxId);
	if (!access?.canRead) return null;
	return access;
}

/** A folder exists exactly where its mailbox says it does, so DELETE/RENAME re-read the row rather than trusting the catalogue. */
async function folderRowExists(db: AppDatabase, target: ImapFolderTarget): Promise<boolean> {
	if (!target.folderId) return false;
	const [row] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.id, target.folderId), eq(folders.mailboxId, target.mailboxId)))
		.limit(1);
	return Boolean(row);
}

/** The database side of the protocol. The catalogue is re-read per call so folder writes show up immediately. */
export function imapMailboxBackend(db: AppDatabase, auth: ApiAuthResult, env: CloudflareEnv): ImapMailboxBackend {
	// No catalogue cache: LIST, SELECT and FETCH all have to see the folder table as it is now, so a
	// folder this session (or another) just created is in the very next LIST reply.
	const list = () => listImapMailboxEntries(db, auth);
	return {
		list,
		counts: (entry) => (entry.selectable ? mailboxCounts(db, auth, entry) : Promise.resolve({ messages: 0, unseen: 0 })),
		messages: async (selected) => {
			const entry = entryForSelected(await list(), selected);
			return entry ? mailboxMessages(db, auth, entry) : [];
		},
		search: async (selected, criteria) => {
			const entry = entryForSelected(await list(), selected);
			return entry ? searchMessages(db, auth, entry, criteria) : [];
		},
		createFolder: (target) => createFolderRow(db, auth, target),
		deleteFolder: (target) => deleteFolderRow(db, auth, target),
		renameFolder: (target, name) => renameFolderRow(db, auth, target, name),
		append: (request) => appendMessage(env, db, auth, request),
		move: (source, messageIds, destination) => moveMessages(db, auth, source, messageIds, destination),
	};
}

/**
 * APPEND. The message is written by `importMessageToMailbox`, the seam REST and JMAP import use: it parses
 * the MIME, dedupes on the Message-ID, fills the envelope/threading columns, stores the raw bytes and the
 * attachments, and lets the schema triggers keep FTS and the change journal current.
 *
 * The destination decides the placement (`getImportMessagePlacement`), which is what makes appending to
 * Sent write direction='outbound'/status='sent' and appending to Drafts write a private draft, instead of
 * a folder-shaped guess. `getImportMessageUserId` follows: sent and draft mail belongs to the appender.
 */
async function appendMessage(env: CloudflareEnv, db: AppDatabase, auth: ApiAuthResult, request: ImapAppendRequest): Promise<ImapAppendResult> {
	const access = await folderWriteAccess(db, auth, request.entry.mailboxId);
	if (!access?.canManage) return "denied";
	const destination: ImportDestination = request.entry.folderId
		? { type: "folder", folderId: request.entry.folderId }
		: { type: "system", section: ROLE_SECTIONS[request.entry.role ?? "inbox"] };
	// A filename is what the synthetic provider id is built from when a message has no Message-ID. An APPEND
	// has no filename, and a fixed one would make the seam's `import:<name>:<bytes>` key collide between two
	// different messages of the same size, so each append names itself: such a message then dedupes on its
	// Message-ID only, which is all IMAP itself dedupes on.
	const filename = `imap-append-${newId("msg")}.eml`;
	try {
		const imported = await importMessageToMailbox(env, {
			userId: getImportMessageUserId(destination, auth.userId, access.mailbox.userId),
			mailboxId: request.entry.mailboxId,
			destination,
			filename,
			raw: request.raw,
			// Not `?? placement.direction`: APPEND states the flags, so a message without \\Seen is unseen.
			read: request.flags.includes("\\Seen"),
			starred: request.flags.includes("\\Flagged"),
			createdAt: request.internalDate ?? undefined,
		});
		return imported ? "ok" : "duplicate";
	} catch (error) {
		// A MIME that will not parse or an attachment the size limits reject leaves no row: the seam deletes what
		// it stored before throwing, so there is nothing to roll back here.
		console.error("IMAP APPEND failed", filename, describeImportError(error));
		return "invalid";
	}
}

/**
 * MOVE. The membership rule is JMAP's: `targetFromMailboxIds` is the same function `Email/set` moves with
 * (one mailbox per message, no received mail into Sent, a folder move that leaves a draft private), applied
 * here to a `MailboxRef` built from the IMAP destination. The follow-up is `Email/set`'s too: one update of
 * `status`/`folder_id`, and a `hidden` journal entry when the move turns a visible message into a draft.
 */
async function moveMessages(
	db: AppDatabase,
	auth: ApiAuthResult,
	source: ImapMailboxEntry,
	messageIds: string[],
	destination: ImapMailboxEntry,
): Promise<ImapMoveOutcome> {
	// `messages.mailbox_id` is in every reader's scope (counts, folders, the change journal), and JMAP refuses
	// the same move, so an IMAP move between two of the account's mailboxes is refused rather than half-written.
	if (destination.mailboxId !== source.mailboxId) return { result: "cross-mailbox" };
	const access = await folderWriteAccess(db, auth, source.mailboxId);
	if (!access?.canManage) return { result: "denied" };
	const ref: MailboxRef = destination.folderId
		? { kind: "folder", mailboxId: destination.mailboxId, folderId: destination.folderId }
		: { kind: "role", mailboxId: destination.mailboxId, role: destination.role ?? "inbox" };
	const rows = await db
		.select()
		.from(messages)
		.where(and(inArray(messages.id, messageIds), eq(messages.mailboxId, source.mailboxId)));
	if (rows.length !== messageIds.length) return { result: "missing" };
	const accessible = new Set([source.mailboxId]);
	const changed: string[] = [];
	for (const row of rows) {
		const target = targetFromMailboxIds(row, { mailboxIds: { [encodeMailboxRef(ref)]: true } }, accessible);
		if (!target) return { result: "missing" };
		if ("error" in target) return { result: "invalid", description: String(target.error.description ?? "Mailboxes cannot hold this message") };
		const status = target.status ?? row.status;
		const folderId = target.folderId !== undefined ? target.folderId : row.folderId;
		// Same mailbox and same folder: IMAP allows the command, and nothing about the row changes.
		if (status === row.status && folderId === row.folderId) continue;
		await db
			.update(messages)
			.set({ status, folderId, ...privateDraftForStatus(status) })
			.where(eq(messages.id, row.id));
		if (status === "draft" && !row.privateDraft) await logMessageHidden(db, row);
		changed.push(row.id);
	}
	return { result: "ok", changed };
}

/** CREATE. `userId` is the mailbox owner, the same column REST and JMAP write. */
async function createFolderRow(db: AppDatabase, auth: ApiAuthResult, target: ImapFolderTarget): Promise<ImapFolderWriteResult> {
	const access = await folderWriteAccess(db, auth, target.mailboxId);
	// Creating a folder is a manage action: a read-only or send-only sharee must not add one.
	if (!access?.canManage) return "denied";
	try {
		await db.insert(folders).values({ id: newId("fld"), userId: access.mailbox.userId, mailboxId: target.mailboxId, name: target.name });
	} catch {
		// The (mailbox_id, name) unique index is the real arbiter; a name collision that slipped past the
		// catalogue check (another session created it meanwhile) answers the same NO as an existing name.
		return "exists";
	}
	return "ok";
}

/** DELETE. The `messages.folder_id` foreign key is `on delete set null`, so folder mail unfiles into its status mailbox. */
async function deleteFolderRow(db: AppDatabase, auth: ApiAuthResult, target: ImapFolderTarget): Promise<ImapFolderWriteResult> {
	const access = await folderWriteAccess(db, auth, target.mailboxId);
	if (!access?.canManage) return "denied";
	if (!(await folderRowExists(db, target))) return "missing";
	await db.delete(folders).where(and(eq(folders.id, target.folderId!), eq(folders.mailboxId, target.mailboxId)));
	return "ok";
}

/** RENAME. The id stays put, so every message that points at this folder still points at it. */
async function renameFolderRow(db: AppDatabase, auth: ApiAuthResult, target: ImapFolderTarget, name: string): Promise<ImapFolderWriteResult> {
	const access = await folderWriteAccess(db, auth, target.mailboxId);
	if (!access?.canManage) return "denied";
	if (!(await folderRowExists(db, target))) return "missing";
	try {
		await db
			.update(folders)
			.set({ name })
			.where(and(eq(folders.id, target.folderId!), eq(folders.mailboxId, target.mailboxId)));
	} catch {
		return "exists";
	}
	return "ok";
}
