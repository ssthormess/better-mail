import type { QueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type {
	ContactGroup,
	ContactGroupMember,
	ContactGroupMembersResponse,
	ContactGroupResponse,
	ContactGroupsData,
	ContactGroupsIndexResponse,
	ContactGroupUpdateResponse,
} from "./contact-groups-types";

export function contactGroupsQueryKey(mailboxId: string) {
	return ["contact-groups", mailboxId] as const;
}

// One scope key for group and member writes, so the UI gate and the synchronous
// rechecks serialize them — an earlier response landing last can never overwrite
// a newer snapshot.
export function contactGroupsWritesKey(mailboxId: string) {
	return ["contact-groups", mailboxId, "writes"] as const;
}

// Validation failures arrive as flattened zod errors ({formErrors, fieldErrors}), not the
// string a 409 conflict sends — surface the first message instead of "[object Object]".
export function apiError(data: { error?: unknown }, fallback: string): Error {
	if (typeof data.error === "string") return new Error(data.error);
	const flat = data.error as { formErrors?: unknown[]; fieldErrors?: Record<string, unknown[]> } | undefined;
	const message = flat?.formErrors?.[0] ?? Object.values(flat?.fieldErrors ?? {}).flat()[0];
	return new Error(typeof message === "string" && message ? message : fallback);
}

// Patch the snapshot after a mutation: cancel an in-flight GET so its stale
// response can't land on top of the patch. If there is no snapshot to patch (the
// cache entry was dropped while a write was in flight), restart the exact query —
// otherwise the cancelled cold GET would leave it pending forever. The restart is
// scheduled, not awaited: a stalled GET must not extend the mutation's pending
// lifetime.
export async function patchContactGroups(
	qc: QueryClient,
	mailboxId: string,
	patch: (current: ContactGroupsData) => ContactGroupsData,
) {
	const queryKey = contactGroupsQueryKey(mailboxId);
	await qc.cancelQueries({ queryKey, exact: true });
	if (qc.getQueryData(queryKey) === undefined) {
		void qc.invalidateQueries({ queryKey, exact: true, refetchType: "all" }).catch(() => {});
		return;
	}
	qc.setQueryData<ContactGroupsData>(queryKey, (current) => (current ? patch(current) : current));
}

// The app's QueryClient disables refetch on mount/focus/reconnect, so a bare
// invalidation never refetches an inactive observer. Every mutation applies its
// server response to the snapshot directly, then this refreshes all observers to
// converge on server truth. A pending first-load GET coalesces with the
// invalidation instead of being replaced, so cancel the exact query first —
// a stale pre-mutation response landing last would hide a fresh write.
// Fire-and-forget: a mutation's pending lifetime must not extend to this
// post-commit refresh.
export function refetchContactGroups(qc: QueryClient, mailboxId: string) {
	const queryKey = contactGroupsQueryKey(mailboxId);
	void qc
		.cancelQueries({ queryKey, exact: true })
		.then(() => qc.invalidateQueries({ queryKey, exact: true, refetchType: "all" }))
		.catch(() => {});
}

/** The index sorts by lower(name) then id — keeps patched snapshots in the same order. */
export function sortContactGroups(groups: ContactGroup[]): ContactGroup[] {
	return [...groups].sort((a, b) => {
		const an = a.name.toLowerCase();
		const bn = b.name.toLowerCase();
		return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/** Inverts membersByGroup once for the contact rows: contact id -> its groups, already name-sorted. */
export function indexGroupsByContact(data: ContactGroupsData | undefined): Record<string, ContactGroup[]> {
	const index: Record<string, ContactGroup[]> = {};
	if (!data) return index;
	for (const group of data.groups) {
		for (const member of data.membersByGroup[group.id] ?? []) {
			(index[member.contactId] ??= []).push(group);
		}
	}
	return index;
}

function mailboxParams(mailboxId: string): string {
	return new URLSearchParams({ mailboxId }).toString();
}

export async function fetchContactGroupsData(mailboxId: string): Promise<ContactGroupsData> {
	const res = await authFetch(`/api/contacts/groups?${mailboxParams(mailboxId)}`);
	const json = (await res.json()) as ContactGroupsIndexResponse;
	if (!res.ok) throw apiError(json, "Failed to load groups");
	const groups = json.groups ?? [];
	// The API exposes members only per group — there is no per-contact reverse
	// lookup — so membership is aggregated here once for the whole page.
	const entries = await Promise.all(
		groups.map(async (group) => [group.id, await fetchContactGroupMembers(mailboxId, group.id)] as const),
	);
	return { groups, membersByGroup: Object.fromEntries(entries) };
}

export async function fetchContactGroupMembers(mailboxId: string, groupId: string): Promise<ContactGroupMember[]> {
	const res = await authFetch(`/api/contacts/groups/${groupId}/members?${mailboxParams(mailboxId)}`);
	const json = (await res.json()) as ContactGroupMembersResponse;
	if (!res.ok) throw apiError(json, "Failed to load members");
	return json.members ?? [];
}

export async function createContactGroup(mailboxId: string, name: string): Promise<ContactGroupResponse> {
	const res = await authFetch("/api/contacts/groups", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, name }),
	});
	const json = (await res.json()) as ContactGroupResponse;
	if (!res.ok) throw apiError(json, "Failed to create group");
	return json;
}

export async function renameContactGroup(
	mailboxId: string,
	groupId: string,
	name: string,
): Promise<ContactGroupUpdateResponse> {
	const res = await authFetch(`/api/contacts/groups/${groupId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, name }),
	});
	const json = (await res.json()) as ContactGroupUpdateResponse;
	if (!res.ok) throw apiError(json, "Failed to rename group");
	return json;
}

export async function deleteContactGroup(mailboxId: string, groupId: string): Promise<void> {
	const res = await authFetch(`/api/contacts/groups/${groupId}?${mailboxParams(mailboxId)}`, { method: "DELETE" });
	const json = (await res.json()) as { error?: unknown };
	if (!res.ok) throw apiError(json, "Failed to delete group");
}

export async function addContactGroupMember(
	mailboxId: string,
	groupId: string,
	contactId: string,
): Promise<ContactGroupMember[]> {
	const res = await authFetch(`/api/contacts/groups/${groupId}/members`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, contactId }),
	});
	const json = (await res.json()) as ContactGroupMembersResponse;
	if (!res.ok) throw apiError(json, "Failed to add member");
	return json.members ?? [];
}

export async function removeContactGroupMember(
	mailboxId: string,
	groupId: string,
	contactId: string,
): Promise<ContactGroupMember[]> {
	const params = new URLSearchParams({ mailboxId, contactId });
	const res = await authFetch(`/api/contacts/groups/${groupId}/members?${params.toString()}`, {
		method: "DELETE",
	});
	const json = (await res.json()) as ContactGroupMembersResponse;
	if (!res.ok) throw apiError(json, "Failed to remove member");
	return json.members ?? [];
}
