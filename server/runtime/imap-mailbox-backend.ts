import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messages } from "@/db/schema";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import type { SystemRole } from "@/lib/jmap/types";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { planImapMailboxEntries } from "./imap-mailboxes";
import type { ImapMailboxBackend, ImapMailboxCounts, ImapMailboxEntry } from "./imap-protocol";

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
	const conditions: SQL[] = [eq(messages.mailboxId, entry.mailboxId), draftsVisibleTo(auth.userId)];
	if (entry.folderId) {
		conditions.push(eq(messages.folderId, entry.folderId));
	} else if (entry.role) {
		conditions.push(isNull(messages.folderId));
		conditions.push(inArray(messages.status, ROLE_STATUSES[entry.role]));
		if (entry.role === "inbox") conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
	} else {
		return { messages: 0, unseen: 0 };
	}
	const [row] = await db
		.select({
			messages: count(),
			unseen: sql<number>`sum(case when not ${messages.read} and ${messages.direction} = 'inbound' then 1 else 0 end)`,
		})
		.from(messages)
		.where(and(...conditions));
	return { messages: Number(row?.messages ?? 0), unseen: Number(row?.unseen ?? 0) };
}

/** The database side of the protocol. The catalogue is loaded once per session, counters per command. */
export function imapMailboxBackend(db: AppDatabase, auth: ApiAuthResult): ImapMailboxBackend {
	let catalogue: Promise<ImapMailboxEntry[]> | null = null;
	return {
		list: () => (catalogue ??= listImapMailboxEntries(db, auth)),
		counts: (entry) => (entry.selectable ? mailboxCounts(db, auth, entry) : Promise.resolve({ messages: 0, unseen: 0 })),
	};
}
