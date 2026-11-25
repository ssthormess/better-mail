import type { MailboxOption } from "./mailbox-provider";

/**
 * Stored in place of a mailbox id when the list shows every mailbox. Mailbox ids
 * are 21-character nanoids, so `*` (outside the nanoid alphabet) can never be one.
 */
export const SELECTED_MAILBOX_ALL_VALUE = "*";

export type StoredMailboxSelection =
	| { kind: "all" }
	| { kind: "mailbox"; id: string }
	| { kind: "unset" };

export function parseStoredMailboxSelection(value: string | null | undefined): StoredMailboxSelection {
	if (!value) return { kind: "unset" };
	if (value === SELECTED_MAILBOX_ALL_VALUE) return { kind: "all" };
	return { kind: "mailbox", id: value };
}

/** What goes back into storage for a selection; a real mailbox is stored by id. */
export function serializeMailboxSelection(mailboxId: string | null): string {
	return mailboxId ?? SELECTED_MAILBOX_ALL_VALUE;
}

export type ResolvedMailboxSelection = {
	mailbox: MailboxOption | null;
	/** Value to write back, or null to leave the stored preference alone. */
	storageValue: string | null;
};

/**
 * Resolve a stored selection against the accessible mailboxes. A stale id falls
 * back to the primary mailbox, and so does "All mailboxes" when only one mailbox
 * is accessible: unified then lists the same messages with no row to tell apart.
 */
export function resolveMailboxSelection(
	items: MailboxOption[],
	stored: StoredMailboxSelection,
): ResolvedMailboxSelection {
	const primary = items.find((mailbox) => mailbox.isPrimary) ?? items[0] ?? null;

	if (stored.kind === "all") {
		if (items.length > 1) return { mailbox: null, storageValue: SELECTED_MAILBOX_ALL_VALUE };
		if (primary) return { mailbox: primary, storageValue: primary.id };
		return { mailbox: null, storageValue: null };
	}

	if (stored.kind === "mailbox") {
		const found = items.find((mailbox) => mailbox.id === stored.id);
		if (found) return { mailbox: found, storageValue: null };
	}

	if (primary) return { mailbox: primary, storageValue: primary.id };
	return { mailbox: null, storageValue: null };
}
