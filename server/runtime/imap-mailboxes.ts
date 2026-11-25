import { encodeMailboxRef, SYSTEM_ROLES } from "@/lib/jmap/ids";
import type { SystemRole } from "@/lib/jmap/types";
import { IMAP_DELIMITER, type ImapFolderTarget, type ImapMailboxEntry } from "./imap-protocol";

/**
 * Display name per system role. JMAP calls the junk role "Spam", but IMAP's
 * convention is Junk; the pin is to emit the honest name, not rename the role.
 */
const ROLE_LABELS: Record<SystemRole, string> = {
	inbox: "INBOX",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	junk: "Junk",
	trash: "Trash",
};

/** The mailbox fields the IMAP catalogue needs. */
export type ImapSourceMailbox = { id: string; localPart: string; hostname: string; isPrimary: boolean };

/**
 * IMAP names for one session's mailboxes. The primary mailbox's folders sit at the
 * root (`INBOX`, `Sent`, `Trash`, and custom folder names); every other mailbox is
 * namespaced under its address (`sales@example.com/INBOX`) behind a `\Noselect`
 * parent, which is the hierarchy the LIST reply exposes.
 *
 * A mailbox only gets bare names when one of them is the account's primary address;
 * without a primary every mailbox is namespaced, so names never depend on list order.
 */
export function planImapMailboxEntries(
	mailboxes: ImapSourceMailbox[],
	foldersByMailbox: Map<string, Array<{ id: string; name: string }>> = new Map(),
): ImapMailboxEntry[] {
	const primary = mailboxes.find((mailbox) => mailbox.isPrimary) ?? null;
	const byAddress = (left: ImapSourceMailbox, right: ImapSourceMailbox) => `${left.localPart}@${left.hostname}`.localeCompare(`${right.localPart}@${right.hostname}`, "en", { sensitivity: "base" });
	const ordered = primary ? [primary, ...mailboxes.filter((mailbox) => mailbox.id !== primary.id).sort(byAddress)] : [...mailboxes].sort(byAddress);
	const entries: ImapMailboxEntry[] = [];
	for (const mailbox of ordered) {
		const address = `${mailbox.localPart}@${mailbox.hostname}`;
		const namespaced = !primary || primary.id !== mailbox.id;
		const prefix = namespaced ? `${address}${IMAP_DELIMITER}` : "";
		// Role names are canonical, so a custom folder that would shadow one is left out of the catalogue.
		const taken = new Set<string>();
		if (namespaced) entries.push({ name: address, ref: "", mailboxId: mailbox.id, role: null, folderId: null, selectable: false });
		for (const role of SYSTEM_ROLES) {
			const name = `${prefix}${ROLE_LABELS[role]}`;
			taken.add(name.toLowerCase());
			entries.push({
				name,
				ref: encodeMailboxRef({ kind: "role", mailboxId: mailbox.id, role }),
				mailboxId: mailbox.id,
				role,
				folderId: null,
				selectable: true,
			});
		}
		const folderRows = [...(foldersByMailbox.get(mailbox.id) ?? [])].sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
		for (const folder of folderRows) {
			const name = `${prefix}${folder.name}`;
			if (taken.has(name.toLowerCase())) continue;
			taken.add(name.toLowerCase());
			entries.push({
				name,
				ref: encodeMailboxRef({ kind: "folder", mailboxId: mailbox.id, folderId: folder.id }),
				mailboxId: mailbox.id,
				role: null,
				folderId: folder.id,
				selectable: true,
			});
		}
	}
	return entries;
}

/**
 * What a CREATE/DELETE/RENAME name means. Resolution is the inverse of
 * `planImapMailboxEntries`: a bare name lands in the primary mailbox, `addr/Name` in that
 * address's mailbox, and a name that matches no namespace is refused exactly like SELECT
 * refuses it, so an inaccessible mailbox stays indistinguishable from a nonexistent one.
 *
 * Folders are flat. The only delimiter use is the `addr/` namespace prefix, so a second
 * delimiter (`addr/A/B`) addresses a parent that does not exist and is refused rather than
 * implying nesting.
 */
export type ImapFolderTargetResolution =
	| { kind: "invalid"; message: string }
	| { kind: "role"; entry: ImapMailboxEntry }
	| { kind: "parent"; entry: ImapMailboxEntry }
	| { kind: "folder"; entry: ImapMailboxEntry; target: ImapFolderTarget }
	| { kind: "new"; target: ImapFolderTarget };

/** The same 80-character cap REST and JMAP enforce on a folder name. */
const MAX_FOLDER_NAME_LENGTH = 80;

export function resolveImapFolderTarget(entries: ImapMailboxEntry[], value: string): ImapFolderTargetResolution {
	const wanted = value.trim();
	if (!wanted) return { kind: "invalid", message: "Empty mailbox name" };
	const lower = wanted.toLowerCase();
	// Names are unique case-insensitively in the catalogue (role names win), so one predicate covers
	// role mailboxes, `addr/` parents and existing folders alike.
	const exact = entries.find((entry) => entry.name.toLowerCase() === lower);
	if (exact) {
		if (!exact.selectable) return { kind: "parent", entry: exact };
		if (exact.role) return { kind: "role", entry: exact };
		return {
			kind: "folder",
			entry: exact,
			target: {
				mailboxId: exact.mailboxId,
				folderId: exact.folderId ?? undefined,
				name: exact.name.slice(exact.name.lastIndexOf(IMAP_DELIMITER) + 1),
				imapName: exact.name,
			},
		};
	}
	const slash = wanted.lastIndexOf(IMAP_DELIMITER);
	if (slash < 0) {
		// Bare names exist only when the account has a primary mailbox; otherwise every name is namespaced.
		const bareMailboxId = entries.find((entry) => entry.name === "INBOX")?.mailboxId;
		if (!bareMailboxId) return { kind: "invalid", message: "No such mailbox" };
		return newFolderTarget(bareMailboxId, wanted, wanted);
	}
	const prefix = wanted.slice(0, slash);
	const name = wanted.slice(slash + 1);
	const parent = entries.find((entry) => !entry.selectable && entry.name.toLowerCase() === prefix.toLowerCase());
	if (!parent) return { kind: "invalid", message: "No such mailbox" };
	if (!name) return { kind: "invalid", message: "Empty mailbox name" };
	return newFolderTarget(parent.mailboxId, name, wanted);
}

function newFolderTarget(mailboxId: string, name: string, imapName: string): ImapFolderTargetResolution {
	if (name.length > MAX_FOLDER_NAME_LENGTH) return { kind: "invalid", message: "Mailbox name is too long" };
	return { kind: "new", target: { mailboxId, name, imapName } };
}
