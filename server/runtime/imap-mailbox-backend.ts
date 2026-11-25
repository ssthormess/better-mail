import { and, asc, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messages } from "@/db/schema";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { newId } from "@/lib/ids";
import type { SystemRole } from "@/lib/jmap/types";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { planImapMailboxEntries } from "./imap-mailboxes";
import type { ImapFolderTarget, ImapFolderWriteResult, ImapMailboxBackend, ImapMailboxCounts, ImapMailboxEntry, ImapMessageEntry, ImapSelectedMailbox } from "./imap-protocol";

/** Statuses each role folder counts, mirroring the JMAP mailbox counts (sent folds in queued and failed). */
const ROLE_STATUSES: Record<SystemRole, string[]> = {
	inbox: ["received"],
	sent: ["sent", "queued", "failed"],
	drafts: ["draft"],
	archive: ["archived"],
	junk: ["spam"],
	trash: ["trash"],
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
		uid: index + 1,
		read: row.read,
		starred: row.starred,
		trashed: row.trashedAt !== null,
		draft: row.status === "draft",
		outbound: row.direction === "outbound",
	}));
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
export function imapMailboxBackend(db: AppDatabase, auth: ApiAuthResult): ImapMailboxBackend {
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
		createFolder: (target) => createFolderRow(db, auth, target),
		deleteFolder: (target) => deleteFolderRow(db, auth, target),
		renameFolder: (target, name) => renameFolderRow(db, auth, target, name),
	};
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
