import { encodeMailboxRef, SYSTEM_ROLES } from "@/lib/jmap/ids";
import type { SystemRole } from "@/lib/jmap/types";
import { IMAP_DELIMITER, type ImapMailboxEntry } from "./imap-protocol";

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
