"use client";

import { useIsMutating, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ContactGroupsManager } from "./contact-groups-manager";
import type { ContactListItem } from "./contacts-page-types";
import {
	addContactGroupMember,
	contactGroupMembersQueryKey,
	contactGroupsQueryKey,
	contactGroupsWritesKey,
	fetchContactGroupMembers,
	fetchContactGroups,
	patchContactGroupMembers,
	patchContactGroups,
	refetchContactGroups,
	removeContactGroupMember,
} from "./contact-groups-utils";

type ContactGroupsDialogProps = {
	mailboxId: string;
	/** Set while the dialog is open — it edits this contact's memberships. */
	contact: ContactListItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/** The assign surface: every group with a checkbox, toggling persists immediately. */
export function ContactGroupsDialog({ mailboxId, contact, open, onOpenChange }: ContactGroupsDialogProps) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const groupsQuery = useQuery({
		queryKey: contactGroupsQueryKey(mailboxId),
		queryFn: () => fetchContactGroups(mailboxId),
		enabled: open && !!mailboxId,
	});
	const groups = groupsQuery.data ?? [];

	// Membership loads lazily, one query per group and only while this surface
	// is open — the API exposes no per-contact reverse lookup, and there is no
	// cheaper way to learn which groups a contact sits in. Each slice is its own
	// query, so a failing members GET degrades just that group's row.
	const memberQueries = useQueries({
		queries: groups.map((group) => ({
			queryKey: contactGroupMembersQueryKey(mailboxId, group.id),
			queryFn: () => fetchContactGroupMembers(mailboxId, group.id),
			enabled: open && !!mailboxId,
		})),
	});

	// Group and member writes share one book-wide scope — while any is in
	// flight every control waits, so arrival order can't undo a newer snapshot.
	const busy = useIsMutating({ mutationKey: contactGroupsWritesKey() }) > 0;

	const toggle = useMutation({
		mutationKey: contactGroupsWritesKey(),
		mutationFn: ({ groupId, member }: { groupId: string; member: boolean }) => {
			if (!contact) return Promise.reject(new Error("No contact selected"));
			return member
				? addContactGroupMember(mailboxId, groupId, contact.id)
				: removeContactGroupMember(mailboxId, groupId, contact.id);
		},
		onSuccess: async (members, { groupId }) => {
			await patchContactGroupMembers(qc, mailboxId, groupId, members);
			await patchContactGroups(qc, mailboxId, (current) =>
				// Insert-vs-update split: a group absent from the snapshot (deleted
				// meanwhile) gets nothing synthesized — the scheduled refetch converges.
				current.map((entry) =>
					entry.id === groupId ? { ...entry, memberCount: members.length } : entry,
				),
			);
			refetchContactGroups(qc);
		},
	});

	const label = contact?.displayName ?? contact?.email ?? "";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("contactGroups.assignTitle", { name: label })}</DialogTitle>
					<DialogDescription>{t("contactGroups.assignDescription")}</DialogDescription>
				</DialogHeader>
				{contact && (
					<div className="space-y-2">
						{groupsQuery.isLoading && <Skeleton className="h-12 w-full rounded-2xl" />}
						{groupsQuery.isError && (
							<p role="alert" className="flex items-center gap-2 text-sm text-red-600">
								{groupsQuery.error instanceof Error
									? groupsQuery.error.message
									: t("contactGroups.loadFailed")}
								<button
									type="button"
									className="underline underline-offset-2"
									onClick={() => groupsQuery.refetch()}
								>
									{t("undo.retry")}
								</button>
							</p>
						)}
						{!groupsQuery.isLoading && !groupsQuery.isError && groups.length === 0 && (
							<p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
								{t("contactGroups.noneAssign")}
							</p>
						)}
						{groups.map((group, index) => {
							const membersQuery = memberQueries[index];
							const member = (membersQuery?.data ?? []).some((entry) => entry.contactId === contact.id);
							return (
								<label
									key={group.id}
									className="flex items-center gap-3 rounded-2xl bg-neutral-50 px-4 py-3 text-sm"
								>
									<Checkbox
										checked={member}
										disabled={busy || !membersQuery?.data}
										onChange={(event) => {
											// Synchronous recheck — the disabled prop only re-renders on
											// mutation state change, so a same-tick toggle could slip through.
											if (qc.isMutating({ mutationKey: contactGroupsWritesKey() }) > 0) return;
											toggle.mutate({ groupId: group.id, member: event.target.checked });
										}}
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-semibold text-neutral-900">{group.name}</span>
										<span className="block text-xs text-neutral-500">
											{t("contactGroups.memberCount", { count: group.memberCount })}
										</span>
									</span>
									{membersQuery?.isError && (
										<button
											type="button"
											className="shrink-0 text-xs text-red-600 underline underline-offset-2"
											onClick={(event) => {
												event.preventDefault();
												void membersQuery.refetch();
											}}
										>
											{t("undo.retry")}
										</button>
									)}
								</label>
							);
						})}
						{toggle.isError && (
							<p role="alert" className="text-sm text-red-600">
								{toggle.error instanceof Error ? toggle.error.message : t("contactGroups.membershipFailed")}
							</p>
						)}
						<div className="flex justify-end border-t border-neutral-200 pt-3">
							<ContactGroupsManager mailboxId={mailboxId} />
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
