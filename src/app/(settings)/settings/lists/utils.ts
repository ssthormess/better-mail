import { authFetch } from "@/lib/auth/client";
import type {
	MailingListDomainsResponse,
	MailingListResponse,
	MailingListsResponse,
} from "./types";

export async function fetchMailingLists(): Promise<MailingListsResponse> {
	const res = await authFetch("/api/mailing-lists");
	const json = (await res.json()) as MailingListsResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load mailing lists");
	return json;
}

export async function fetchMailingListDomains(): Promise<MailingListDomainsResponse> {
	const res = await authFetch("/api/domains");
	const json = (await res.json()) as MailingListDomainsResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load domains");
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
	const json = (await res.json()) as MailingListResponse & { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to create list");
	return json;
}

export async function deleteMailingList(id: string): Promise<void> {
	const res = await authFetch(`/api/mailing-lists/${id}`, { method: "DELETE" });
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to delete list");
}
