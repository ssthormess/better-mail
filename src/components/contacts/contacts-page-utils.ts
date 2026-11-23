import toast from "react-hot-toast";
import { authFetch } from "@/lib/auth/client";
import type { Translator } from "@/lib/i18n/utils";
import type {
	ContactImportConflict,
	ContactImportPreview,
	ContactImportResult,
	ContactListItem,
	ContactMutationResponse,
	ContactsListResponse,
} from "./contacts-page-types";

export const CONTACTS_QUERY_LIMIT = 500;

export async function fetchContacts(mailboxId: string, query: string): Promise<ContactListItem[]> {
	const params = new URLSearchParams({ mailboxId, limit: String(CONTACTS_QUERY_LIMIT) });
	if (query.trim()) params.set("q", query.trim());
	const response = await authFetch(`/api/contacts?${params.toString()}`);
	const data = (await response.json()) as ContactsListResponse;
	if (!response.ok) throw new Error(data.error ?? "Unable to load contacts");
	return data.contacts ?? [];
}

export async function createContact(
	mailboxId: string,
	input: { address: string; displayName?: string },
): Promise<ContactListItem> {
	const response = await authFetch("/api/contacts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, address: input.address, displayName: input.displayName }),
	});
	const data = (await response.json()) as ContactMutationResponse;
	if (!response.ok || !data.contact) throw new Error(data.error ?? "Unable to save contact");
	return data.contact;
}

export async function renameContact(
	mailboxId: string,
	address: string,
	displayName: string,
): Promise<ContactListItem> {
	const response = await authFetch("/api/contacts", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, address, displayName }),
	});
	const data = (await response.json()) as ContactMutationResponse;
	if (!response.ok || !data.contact) throw new Error(data.error ?? "Unable to save contact");
	return data.contact;
}

export async function exportContacts(mailboxId: string, format: "vcf" | "csv"): Promise<void> {
	const params = new URLSearchParams({ mailboxId, format });
	const response = await authFetch(`/api/export/contacts?${params.toString()}`);
	if (!response.ok) {
		const data = (await response.json()) as { error?: string };
		throw new Error(data.error ?? "Unable to export contacts");
	}

	const blob = await response.blob();
	// The server names the file; Content-Disposition keeps that the single source of truth.
	const filename = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? `contacts.${format}`;
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export async function importContacts(
	mailboxId: string,
	file: File,
	options: { format?: "vcf" | "csv"; conflict?: ContactImportConflict } = {},
): Promise<ContactImportResult> {
	const body = new FormData();
	body.set("mailboxId", mailboxId);
	body.set("file", file);
	if (options.format) body.set("format", options.format);
	if (options.conflict) body.set("conflict", options.conflict);
	const response = await authFetch("/api/import/contacts", { method: "POST", body });
	const data = (await response.json()) as Partial<ContactImportResult> & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to import contacts");
	return {
		imported: data.imported ?? 0,
		updated: data.updated ?? 0,
		skipped: data.skipped ?? 0,
		failed: data.failed ?? 0,
	};
}

/** Classifies the upload's rows against the address book without writing — the file is posted again on confirm. */
export async function previewContactImport(mailboxId: string, file: File): Promise<ContactImportPreview> {
	const body = new FormData();
	body.set("mailboxId", mailboxId);
	body.set("file", file);
	body.set("format", "csv");
	body.set("preview", "1");
	const response = await authFetch("/api/import/contacts", { method: "POST", body });
	const data = (await response.json()) as ContactImportPreview & { error?: string };
	if (!response.ok || !data.preview) throw new Error(data.error ?? "Unable to import contacts");
	return data;
}

/** Toast the import counts; returns whether anything was written so callers can refresh the list. */
export function reportImportResult(t: Translator, result: ContactImportResult): boolean {
	const totals = {
		imported: result.imported,
		updated: result.updated,
		skipped: result.skipped,
		failed: result.failed,
	};
	if (result.imported + result.updated === 0) {
		// The file parsed but nothing was written: show the counts when there
		// were rows to try, or that it simply held no contacts at all.
		toast.error(result.skipped + result.failed > 0 ? t("contacts.importSummarySkipped", totals) : t("contacts.importEmpty"));
		return false;
	}
	toast.success(
		result.skipped + result.failed > 0 ? t("contacts.importSummarySkipped", totals) : t("contacts.importSummary", totals),
	);
	return true;
}

export async function deleteContact(mailboxId: string, address: string): Promise<void> {
	const params = new URLSearchParams({ mailboxId, address });
	const response = await authFetch(`/api/contacts?${params.toString()}`, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json()) as ContactMutationResponse;
		throw new Error(data.error ?? "Unable to delete contact");
	}
}

/** Shared by the header and rows so the columns line up. */
export const CONTACT_COLUMNS =
	"grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_auto]";
