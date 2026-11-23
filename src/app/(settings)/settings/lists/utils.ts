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
// Insert is create-only: a count/name patch must never synthesize a partial row for an
// id the index does not have (deleted, or simply absent from an older snapshot).
export function insertMailingListIntoIndex(qc: QueryClient, list: MailingList) {
	qc.setQueryData<MailingListsResponse>(["mailing-lists"], (current) => {
		if (!current || current.lists.some((entry) => entry.id === list.id)) return current;
		return { lists: [...current.lists, list] };
	});
}

export function updateMailingListInIndex(qc: QueryClient, patch: Partial<MailingList> & { id: string }) {
	qc.setQueryData<MailingListsResponse>(["mailing-lists"], (current) => {
		if (!current || !current.lists.some((entry) => entry.id === patch.id)) return current;
		return { lists: current.lists.map((entry) => (entry.id === patch.id ? { ...entry, ...patch } : entry)) };
	});
}

export function removeMailingListFromIndex(qc: QueryClient, id: string) {
	qc.setQueryData<MailingListsResponse>(["mailing-lists"], (current) =>
		current ? { lists: current.lists.filter((entry) => entry.id !== id) } : current,
	);
}

export async function refetchMailingListIndex(qc: QueryClient) {
	// A pending first-load GET has no cached data, so an implicit invalidation refetch
	// coalesces with it instead of replacing it — a stale pre-mutation response would
	// land last and hide a fresh create. Cancel the exact query first.
	await qc.cancelQueries({ queryKey: ["mailing-lists"], exact: true });
	return qc.invalidateQueries({ queryKey: ["mailing-lists"], exact: true, refetchType: "all" });
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
