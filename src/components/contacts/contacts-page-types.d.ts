import type { ContactSource } from "@/lib/email/address-types";

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

export type ContactImportResult = {
	imported: number;
	updated: number;
	skipped: number;
	failed: number;
};

/** What an import does when a row's address is already a contact. */
export type ContactImportConflict = "update" | "skip";

export type ContactImportPreviewRow = {
	/** Spreadsheet row number for CSV, card index for vCard. */
	row: number;
	email: string | null;
	name: string | null;
	status: "new" | "existing" | "invalid" | "dup" | "unknown";
};

export type ContactImportPreview = {
	preview: true;
	counts: {
		new: number;
		existing: number;
		invalid: number;
		duplicates: number;
		/** Candidates the delegated visibility scan could not verify — shown honestly instead of claimed new. */
		unknown: number;
		/** Rows the parser dropped before classification (over-cap, unreadable cards). */
		skipped: number;
	};
	rows: ContactImportPreviewRow[];
};

export type ContactImportDialogProps = {
	mailboxId: string;
	/** The picked .csv file; null closes the dialog. */
	file: File | null;
	onOpenChange: (open: boolean) => void;
	onImported: () => void;
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
	onEmail: (contact: ContactListItem) => void;
	onEdit: (contact: ContactListItem) => void;
	onDelete: (contact: ContactListItem) => void;
};
