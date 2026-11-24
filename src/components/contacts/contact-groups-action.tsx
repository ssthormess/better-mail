"use client";

import { useState } from "react";
import { Tag01 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ContactGroupsDialog } from "./contact-groups-dialog";
import type { ContactListItem } from "./contacts-page-types";

/**
 * The row affordance for group membership: a tag button that opens the assign
 * dialog. The API gates groups on canManage — the same full_access signal the
 * other mailbox surfaces use — so a read-only delegate gets neither button nor
 * fetch, and a permission drop unmounts the whole subtree, dialog included.
 */
export function ContactGroupsAction({ mailboxId, contact }: { mailboxId: string; contact: ContactListItem }) {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const [open, setOpen] = useState(false);
	const canManage = selectedMailbox?.permission === "full_access";

	if (!canManage) return null;

	const label = contact.displayName ?? contact.email;
	return (
		<>
			<Tooltip label={t("contactGroups.editFor", { name: label })}>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setOpen(true)}
					aria-label={t("contactGroups.editFor", { name: label })}
				>
					<Tag01 className="h-4 w-4" />
				</Button>
			</Tooltip>
			<ContactGroupsDialog mailboxId={mailboxId} contact={contact} open={open} onOpenChange={setOpen} />
		</>
	);
}
