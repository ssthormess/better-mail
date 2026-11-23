import type { QueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type {
	ContactGroup,
	ContactGroupMember,
	ContactGroupMembersResponse,
	ContactGroupResponse,
	ContactGroupsIndexResponse,
	ContactGroupUpdateResponse,
} from "./contact-groups-types";

export function contactGroupsQueryKey(mailboxId: string) {
	return ["contact-groups", mailboxId] as const;
}

export function contactGroupMembersQueryKey(mailboxId: string, groupId: string) {
	return ["contact-groups", mailboxId, "members", groupId] as const;
}

// One scope key for group and member writes, so the UI gate and the synchronous
// rechecks serialize them — an earlier response landing last can never overwrite
// a newer snapshot. It is deliberately mailbox-free: groups live on the mailbox
// owner's contact book, so two mailbox keys can front the same book and writes
// through either must serialize.
export function contactGroupsWritesKey() {
	return ["contact-groups", "writes"] as const;
}

// Validation failures arrive as flattened zod errors ({formErrors, fieldErrors}), not the
// string a 409 conflict sends — surface the first message instead of "[object Object]".
export function apiError(data: { error?: unknown }, fallback: string): Error {
	if (typeof data.error === "string") return new Error(data.error);
	const flat = data.error as { formErrors?: unknown[]; fieldErrors?: Record<string, unknown[]> } | undefined;
	const message = flat?.formErrors?.[0] ?? Object.values(flat?.fieldErrors ?? {}).flat()[0];
	return new Error(typeof message === "string" && message ? message : fallback);
}

// Patch a snapshot after a mutation: cancel an in-flight GET so its stale
// response can't land on top of the patch. If there is no snapshot to patch (the
// cache entry was dropped while a write was in flight), restart the exact query —
// otherwise the cancelled cold GET would leave it pending forever. The restart is
// scheduled, not awaited: a stalled GET must not extend the mutation's pending
// lifetime. "active" only — an unwatched key goes stale and refetches on its next
// enabled mount, so a mailbox that lost manage rights mid-write never sees a
// doomed read fire from this path.
export async function patchContactGroups(
	qc: QueryClient,
	mailboxId: string,
	patch: (current: ContactGroup[]) => ContactGroup[],
) {
	const queryKey = contactGroupsQueryKey(mailboxId);
	await qc.cancelQueries({ queryKey, exact: true });
	if (qc.getQueryData(queryKey) === undefined) {
		void qc.invalidateQueries({ queryKey, exact: true, refetchType: "active" }).catch(() => {});
		return;
	}
	qc.setQueryData<ContactGroup[]>(queryKey, (current) => (current ? patch(current) : current));
}

// Same discipline for one group's member slice: the member write responses carry
// the fresh slice, so a cached entry is overwritten; a missing entry just needs
// the (possibly cancelled) GET restarted — and the same "active" restriction, so
// a downgraded mailbox's unwatched slice goes stale instead of firing a read.
export async function patchContactGroupMembers(
	qc: QueryClient,
	mailboxId: string,
	groupId: string,
	members: ContactGroupMember[],
) {
	const queryKey = contactGroupMembersQueryKey(mailboxId, groupId);
	await qc.cancelQueries({ queryKey, exact: true });
	if (qc.getQueryData(queryKey) === undefined) {
		void qc.invalidateQueries({ queryKey, exact: true, refetchType: "active" }).catch(() => {});
		return;
	}
	qc.setQueryData<ContactGroupMember[]>(queryKey, members);
}

// The app's QueryClient disables refetch on mount/focus/reconnect, so a bare
// invalidation never refetches an inactive observer. Every mutation applies its
// server response to the snapshot directly, then this refreshes observers to
// converge on server truth. The contact book is owner-scoped — several mailbox
// keys can front the same groups — so the whole "contact-groups" prefix is
// cancelled and invalidated, not just the active mailbox's entry.
// refetchType "active" is deliberate: a query only counts as active while an
// enabled observer watches it, and enabled observers exist only inside
// manage-gated surfaces — so a mailbox that lost manage rights (or whose
// surface unmounted) gets its keys marked stale without firing reads it can no
// longer serve. They refetch on their next enabled mount.
// Fire-and-forget: a mutation's pending lifetime must not extend to this
// post-commit refresh.
export function refetchContactGroups(qc: QueryClient) {
	void qc
		.cancelQueries({ queryKey: ["contact-groups"] })
		.then(() => qc.invalidateQueries({ queryKey: ["contact-groups"], refetchType: "active" }))
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

function mailboxParams(mailboxId: string): string {
	return new URLSearchParams({ mailboxId }).toString();
}

export async function fetchContactGroups(mailboxId: string): Promise<ContactGroup[]> {
	const res = await authFetch(`/api/contacts/groups?${mailboxParams(mailboxId)}`);
	const json = (await res.json()) as ContactGroupsIndexResponse;
	if (!res.ok) throw apiError(json, "Failed to load groups");
	return json.groups ?? [];
}

// Member lists are fetched lazily per group — only surfaces that need membership
// (the assign dialog) run this, each group in its own query so one failure
// degrades a single row instead of the whole surface.
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
