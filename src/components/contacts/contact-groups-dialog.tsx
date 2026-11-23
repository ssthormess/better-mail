"use client";

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import type { ContactListItem } from "./contacts-page-types";
import {
	addContactGroupMember,
	contactGroupsQueryKey,
	contactGroupsWritesKey,
	fetchContactGroupsData,
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
		queryFn: () => fetchContactGroupsData(mailboxId),
		enabled: !!mailboxId,
	});
	const groups = groupsQuery.data?.groups ?? [];
	const membersByGroup = groupsQuery.data?.membersByGroup ?? {};

	// Group writes share the mailbox-wide scope: while any is in flight every
	// toggle waits, so arrival order can't undo a newer snapshot.
	const busy = useIsMutating({ mutationKey: contactGroupsWritesKey(mailboxId) }) > 0;

	const toggle = useMutation({
		mutationKey: contactGroupsWritesKey(mailboxId),
		mutationFn: ({ groupId, member }: { groupId: string; member: boolean }) => {
			if (!contact) return Promise.reject(new Error("No contact selected"));
			return member
				? addContactGroupMember(mailboxId, groupId, contact.id)
				: removeContactGroupMember(mailboxId, groupId, contact.id);
		},
		onSuccess: async (members, { groupId }) => {
			await patchContactGroups(qc, mailboxId, (current) => {
				// Insert-vs-update split: a group absent from the snapshot (deleted
				// meanwhile) gets nothing synthesized — the scheduled refetch converges.
				if (!current.groups.some((entry) => entry.id === groupId)) return current;
				return {
					groups: current.groups.map((entry) =>
						entry.id === groupId ? { ...entry, memberCount: members.length } : entry,
					),
					membersByGroup: { ...current.membersByGroup, [groupId]: members },
				};
			});
			refetchContactGroups(qc, mailboxId);
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
						{groups.map((group) => {
							const member = (membersByGroup[group.id] ?? []).some((entry) => entry.contactId === contact.id);
							return (
								<label
									key={group.id}
									className="flex items-center gap-3 rounded-2xl bg-neutral-50 px-4 py-3 text-sm"
								>
									<Checkbox
										checked={member}
										disabled={busy}
										onChange={(event) => {
											// Synchronous recheck — the disabled prop only re-renders on
											// mutation state change, so a same-tick toggle could slip through.
											if (qc.isMutating({ mutationKey: contactGroupsWritesKey(mailboxId) }) > 0) return;
											toggle.mutate({ groupId: group.id, member: event.target.checked });
										}}
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-semibold text-neutral-900">{group.name}</span>
										<span className="block text-xs text-neutral-500">
											{t("contactGroups.memberCount", { count: group.memberCount })}
										</span>
									</span>
								</label>
							);
						})}
						{toggle.isError && (
							<p role="alert" className="text-sm text-red-600">
								{toggle.error instanceof Error ? toggle.error.message : t("contactGroups.membershipFailed")}
							</p>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
