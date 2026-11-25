"use client";

import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";

/**
 * The mailbox per-mailbox pages and writes act on: the selected one, or the
 * primary while the list shows every mailbox (unified mode).
 */
export function useActiveMailbox(): MailboxOption | null {
	const { selectedMailbox, mailboxes } = useSelectedMailbox();
	return selectedMailbox ?? mailboxes.find((mailbox) => mailbox.isPrimary) ?? mailboxes[0] ?? null;
}

/**
 * Whether lists merge every accessible mailbox. A single mailbox would list the
 * same messages either way, so it never counts as unified and gains no chrome;
 * neither does the window before the mailboxes have loaded.
 */
export function useUnifiedInbox(): boolean {
	const { selectedMailbox, mailboxes, isLoading } = useSelectedMailbox();
	return !isLoading && selectedMailbox === null && mailboxes.length > 1;
}
