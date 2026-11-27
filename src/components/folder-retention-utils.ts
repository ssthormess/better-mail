import { authFetch } from "@/lib/auth/client";
import { normalizeTrashRetentionDays } from "@/lib/email/trash-retention-utils";

/** Prefill for the days input when a rule is switched on; 30 is the middle of the account presets. */
export const DEFAULT_FOLDER_RETENTION_DAYS = 30;

/**
 * What the retention section reports to the dialog that hosts it. The dialog saves `days` on its own
 * Save when the draft changed; `baseline` is the rule the server had when the section loaded, so a
 * no-op edit never produces a write.
 */
export type FolderRetentionDraft = {
	/** The rule the input asks for; null means "no folder rule" (fall back to the account's Trash/Spam retention). */
	days: number | null;
	/** The rule the server reported when the section loaded. */
	baseline: number | null;
	/** The days input is a whole number in the API's 1-365 range, or the rule is switched off. */
	valid: boolean;
};

/** Mirrors the server: the retention route's PATCH needs the same manage right as editing the folder. */
export function canEditFolderRetention(permission: string | undefined): boolean {
	return permission === "full_access";
}

/** A draft is only a write when it parses and differs from what the server reported. */
export function folderRetentionIsDirty(draft: FolderRetentionDraft | null): draft is FolderRetentionDraft {
	return !!draft && draft.valid && draft.days !== draft.baseline;
}

/**
 * Parses the days input like the API does: a whole number in 1-365. Anything else — empty, text,
 * fractional, out of range — is null, which callers treat as "not saveable", never as "clear".
 */
export function parseFolderRetentionDays(raw: string): number | null {
	if (!raw.trim()) return null;
	return normalizeTrashRetentionDays(Number(raw));
}

/**
 * The draft the section reports for a given toggle/input pair. While the input is invalid the
 * reported `days` stays at the baseline, so a consumer that ignored `valid` still cannot clear
 * or shrink a rule by accident.
 */
export function folderRetentionDraft(enabled: boolean, input: string, baseline: number | null): FolderRetentionDraft {
	const parsed = enabled ? parseFolderRetentionDays(input) : null;
	const valid = !enabled || parsed !== null;
	return { days: valid ? parsed : baseline, baseline, valid };
}

export async function getFolderRetention(folderId: string): Promise<number | null> {
	const response = await authFetch(`/api/folders/${folderId}/retention`);
	const data = (await response.json().catch(() => null)) as { days?: unknown; error?: unknown } | null;
	if (!response.ok) {
		const error = data?.error;
		throw new Error(typeof error === "string" ? error : "Failed to load folder retention");
	}
	return normalizeTrashRetentionDays(data?.days);
}

export async function updateFolderRetention(folderId: string, days: number | null): Promise<number | null> {
	const response = await authFetch(`/api/folders/${folderId}/retention`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ days }),
	});
	const data = (await response.json().catch(() => null)) as { days?: unknown; error?: unknown } | null;
	if (!response.ok) {
		const error = data?.error;
		throw new Error(typeof error === "string" ? error : "Failed to update folder retention");
	}
	return normalizeTrashRetentionDays(data?.days);
}

/**
 * Writes the draft the folder dialog collected, if any. Only a valid, changed draft from a mailbox
 * the user may manage produces a PATCH; everything else is a no-op. Returns whether a rule was
 * written — the API echoes the stored value, which is the draft's `days` by construction.
 */
export async function saveFolderRetentionDraft(
	folderId: string,
	draft: FolderRetentionDraft | null,
	permission: string | undefined,
): Promise<boolean> {
	if (!canEditFolderRetention(permission) || !folderRetentionIsDirty(draft)) return false;
	await updateFolderRetention(folderId, draft.days);
	return true;
}
