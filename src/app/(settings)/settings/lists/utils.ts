import type { QueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type {
	MailingList,
	MailingListDomainsResponse,
	MailingListResponse,
	MailingListsResponse,
} from "./types";

// Validation failures arrive as flattened zod errors ({formErrors, fieldErrors}), not the
// string a 409 conflict sends — surface the first message instead of "[object Object]".
export function apiError(data: { error?: unknown }, fallback: string): Error {
	if (typeof data.error === "string") return new Error(data.error);
	const flat = data.error as { formErrors?: unknown[]; fieldErrors?: Record<string, unknown[]> } | undefined;
	const message = flat?.formErrors?.[0] ?? Object.values(flat?.fieldErrors ?? {}).flat()[0];
	return new Error(typeof message === "string" && message ? message : fallback);
}

// The app's QueryClient disables refetch on mount/focus/reconnect, so a bare invalidation
// never refetches the unmounted index observer. Apply each mutation's server response to
// the index snapshot directly, then refetch every observer to converge on server truth.
export function updateMailingListInIndex(qc: QueryClient, list: Partial<MailingList> & { id: string }) {
	qc.setQueryData<MailingListsResponse>(["mailing-lists"], (current) => {
		if (!current) return current;
		return {
			lists: current.lists.some((entry) => entry.id === list.id)
				? current.lists.map((entry) => (entry.id === list.id ? { ...entry, ...list } : entry))
				: [...current.lists, list as MailingList],
		};
	});
}

export function removeMailingListFromIndex(qc: QueryClient, id: string) {
	qc.setQueryData<MailingListsResponse>(["mailing-lists"], (current) =>
		current ? { lists: current.lists.filter((entry) => entry.id !== id) } : current,
	);
}

export function refetchMailingListIndex(qc: QueryClient) {
	return qc.invalidateQueries({ queryKey: ["mailing-lists"], refetchType: "all" });
}

export async function fetchMailingLists(): Promise<MailingListsResponse> {
	const res = await authFetch("/api/mailing-lists");
	const json = (await res.json()) as MailingListsResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to load mailing lists");
	return json;
}

export async function fetchMailingListDomains(): Promise<MailingListDomainsResponse> {
	const res = await authFetch("/api/domains");
	const json = (await res.json()) as MailingListDomainsResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to load domains");
	return json;
}

export async function createMailingList(input: {
	domainId: string;
	localPart: string;
	name: string;
	description?: string;
	postingPolicy: "members_only" | "anyone";
	moderated: boolean;
}): Promise<MailingListResponse> {
	const res = await authFetch("/api/mailing-lists", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as MailingListResponse & { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to create list");
	return json;
}

export async function deleteMailingList(id: string): Promise<void> {
	const res = await authFetch(`/api/mailing-lists/${id}`, { method: "DELETE" });
	const json = (await res.json()) as { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to delete list");
}
