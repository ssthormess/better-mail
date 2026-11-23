import type { ContactSource } from "@/lib/email/address-types";
import type { ContactGroup } from "./contact-groups-types";

export type ContactListItem = {
	id: string;
	userId: string;
	email: string;
	displayName: string | null;
	source: ContactSource;
	blocked: boolean;
	remoteContentAllowed: boolean;
	lastSeenAt: string | null;
	createdAt: string;
	hasAvatar: boolean;
};

export type ContactsListResponse = {
	contacts?: ContactListItem[];
	error?: string;
};

export type ContactMutationResponse = {
	contact?: ContactListItem;
	ok?: boolean;
	error?: string;
};

export type ContactEditDialogProps = {
	mailboxId: string;
	/** Set for renaming an existing contact; unset creates a new one. */
	contact: ContactListItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: (contact: ContactListItem) => void;
};

export type ContactDeleteDialogProps = {
	mailboxId: string;
	contact: ContactListItem | null;
	onOpenChange: (open: boolean) => void;
	onDeleted: (contact: ContactListItem) => void;
};

export type ContactRowProps = {
	mailboxId: string;
	contact: ContactListItem;
	/** The contact's groups, derived client-side from each group's member list. */
	groups?: ContactGroup[];
	onEmail: (contact: ContactListItem) => void;
	onEdit: (contact: ContactListItem) => void;
	/** Passed only where the caller may manage groups — the row hides the action otherwise. */
	onAssignGroups?: (contact: ContactListItem) => void;
	onDelete: (contact: ContactListItem) => void;
};
