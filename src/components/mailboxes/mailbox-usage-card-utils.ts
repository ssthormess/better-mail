import { authFetch } from "@/lib/auth/client";
import type { MailboxUsageResponse } from "./mailbox-usage-card-types";

export function mailboxUsageQueryKey(mailboxId: string) {
	return ["mailbox", mailboxId, "usage"] as const;
}

// GET /usage sits behind the same manage gate as the settings actions
// (getMailboxSettingsAccess -> canManage). On the mailbox payload that gate
// surfaces as `permission`: owners and full_access delegates carry
// "full_access", and an admin who can manage the owner's account arrives with
// null from the access fallback. read_only / send_as / send_on_behalf mounts
// can only 404, so the query must never fire for them.
// One under-rendered edge: an eligible admin who also holds an explicit
// delegate grant below full_access keeps that lower permission in the page
// payload, so the card stays hidden even though GET /api/mailboxes/[id]/usage
// would serve them. Hiding is the safe direction — a query that might 404
// never fires.
export function canViewMailboxUsage(
	permission: "read_only" | "send_as" | "send_on_behalf" | "full_access" | null | undefined,
): boolean {
	return permission === "full_access" || permission === null;
}

export async function fetchMailboxUsage(id: string): Promise<MailboxUsageResponse> {
	const res = await authFetch(`/api/mailboxes/${id}/usage`);
	const json = (await res.json()) as MailboxUsageResponse;
	if (!res.ok) throw new Error(json.error ?? "Failed to load storage usage");
	return json;
}
