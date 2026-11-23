import type { QueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type { MailingListMember, MailingListMembersResponse } from "../types";
import { apiError } from "../utils";
import type { MailingListDetailResponse, MailingListUpdateResponse } from "./types";

// One scope key for every write that touches this list (member add/edit/remove and the
// list delete), so the UI gate and the synchronous rechecks serialize them all.
export function mailingListWritesKey(listId: string) {
	return ["mailing-list", listId, "writes"] as const;
}

// Patch the detail snapshot after a mutation: cancel an in-flight GET so its stale
// response can't land on top of the patch. If there is no snapshot to patch (the cache
// entry was dropped while a write was in flight), restart the exact query — otherwise
// the cancelled cold GET would leave it pending forever.
export async function patchMailingListDetail(
	qc: QueryClient,
	listId: string,
	patch: (current: MailingListDetailResponse) => MailingListDetailResponse,
) {
	const queryKey = ["mailing-list", listId] as const;
	await qc.cancelQueries({ queryKey });
	if (qc.getQueryData(queryKey) === undefined) {
		await qc.invalidateQueries({ queryKey, exact: true, refetchType: "all" });
		return;
	}
	qc.setQueryData<MailingListDetailResponse>(queryKey, (current) => (current ? patch(current) : current));
}

export async function fetchMailingList(id: string): Promise<MailingListDetailResponse> {
	const res = await authFetch(`/api/mailing-lists/${id}`);
	const json = (await res.json()) as MailingListDetailResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to load list");
	return json;
}

export async function updateMailingList(
	id: string,
	input: {
		name?: string;
		description?: string | null;
		postingPolicy?: "members_only" | "anyone";
		moderated?: boolean;
		disabled?: boolean;
	},
): Promise<MailingListUpdateResponse> {
	const res = await authFetch(`/api/mailing-lists/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as MailingListUpdateResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to update list");
	return json;
}

export async function addMailingListMember(
	id: string,
	input: { email: string; name?: string; role: "owner" | "member"; moderated: boolean },
): Promise<MailingListMember[]> {
	const res = await authFetch(`/api/mailing-lists/${id}/members`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as MailingListMembersResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to add member");
	return json.members;
}

export async function updateMailingListMember(
	id: string,
	memberId: string,
	input: { name?: string | null; role?: "owner" | "member"; moderated?: boolean },
): Promise<MailingListMember[]> {
	const res = await authFetch(`/api/mailing-lists/${id}/members`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ memberId, ...input }),
	});
	const json = (await res.json()) as MailingListMembersResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to update member");
	return json.members;
}

export async function removeMailingListMember(id: string, memberId: string): Promise<MailingListMember[]> {
	const res = await authFetch(`/api/mailing-lists/${id}/members?memberId=${encodeURIComponent(memberId)}`, {
		method: "DELETE",
	});
	const json = (await res.json()) as MailingListMembersResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to remove member");
	return json.members;
}
