"use client";

import type { MailboxOption } from "@/components/mailbox-provider";
import { getMailboxAddress, getRowMailboxLabel } from "./utils";

/**
 * Unified inbox only: which mailbox a list row belongs to. Lists scoped to one
 * mailbox pass no mailbox, so single-mailbox mode gains no chrome.
 */
export function MessageRowMailboxBadge({ mailbox }: { mailbox?: MailboxOption | null }) {
	const label = getRowMailboxLabel(mailbox);
	if (!label) return null;

	return (
		<span
			title={getMailboxAddress(mailbox) ?? label}
			className="ms-2 inline-flex max-w-36 shrink-0 items-center truncate rounded-md bg-neutral-100 px-1.5 text-[11px] font-medium leading-5 text-neutral-600 ring-1 ring-inset ring-neutral-200"
		>
			{label}
		</span>
	);
}
