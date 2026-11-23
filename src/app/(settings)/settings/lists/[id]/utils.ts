import { authFetch } from "@/lib/auth/client";
import type { MailingListMember, MailingListMembersResponse } from "../types";
import type { MailingListDetailResponse, MailingListUpdateResponse } from "./types";

export async function fetchMailingList(id: string): Promise<MailingListDetailResponse> {
	const res = await authFetch(`/api/mailing-lists/${id}`);
	const json = (await res.json()) as MailingListDetailResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load list");
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
	const json = (await res.json()) as MailingListUpdateResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to update list");
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
	const json = (await res.json()) as MailingListMembersResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to add member");
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
	const json = (await res.json()) as MailingListMembersResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to update member");
	return json.members;
}

export async function removeMailingListMember(id: string, memberId: string): Promise<MailingListMember[]> {
	const res = await authFetch(`/api/mailing-lists/${id}/members?memberId=${encodeURIComponent(memberId)}`, {
		method: "DELETE",
	});
	const json = (await res.json()) as MailingListMembersResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to remove member");
	return json.members;
}
