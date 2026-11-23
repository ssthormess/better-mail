"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Tags, Trash2, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ContactGroup } from "./contact-groups-types";
import {
	contactGroupsQueryKey,
	contactGroupsWritesKey,
	createContactGroup,
	deleteContactGroup,
	fetchContactGroupsData,
	patchContactGroups,
	refetchContactGroups,
	renameContactGroup,
	sortContactGroups,
} from "./contact-groups-utils";

/** The Groups button plus the management surface: create, rename, delete, member counts. */
export function ContactGroupsManager({ mailboxId }: { mailboxId: string }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [newName, setNewName] = useState("");
	const [renaming, setRenaming] = useState<ContactGroup | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const groupsQuery = useQuery({
		queryKey: contactGroupsQueryKey(mailboxId),
		queryFn: () => fetchContactGroupsData(mailboxId),
		enabled: !!mailboxId,
	});
	const groups = groupsQuery.data?.groups ?? [];

	// Group and member writes share the mailbox-wide scope — while any is in
	// flight every control waits, so arrival order can't undo a newer snapshot.
	const busy = useIsMutating({ mutationKey: contactGroupsWritesKey(mailboxId) }) > 0;

	const create = useMutation({
		mutationKey: contactGroupsWritesKey(mailboxId),
		mutationFn: (name: string) => createContactGroup(mailboxId, name),
		onSuccess: async ({ group }) => {
			if (group) {
				// Insert is create-only: skip an id the index already has.
				await patchContactGroups(qc, mailboxId, (current) => ({
					groups: current.groups.some((entry) => entry.id === group.id)
						? current.groups
						: sortContactGroups([...current.groups, group]),
					membersByGroup: { ...current.membersByGroup, [group.id]: current.membersByGroup[group.id] ?? [] },
				}));
			}
			refetchContactGroups(qc, mailboxId);
			setNewName("");
		},
	});

	const rename = useMutation({
		mutationKey: contactGroupsWritesKey(mailboxId),
		mutationFn: ({ id, name }: { id: string; name: string }) => renameContactGroup(mailboxId, id, name),
		onSuccess: async ({ group: updated }) => {
			if (updated) {
				// PATCH answers the raw row without memberCount — keep the cached count.
				await patchContactGroups(qc, mailboxId, (current) => ({
					groups: sortContactGroups(
						current.groups.map((entry) =>
							entry.id === updated.id ? { ...entry, name: updated.name } : entry,
						),
					),
					membersByGroup: current.membersByGroup,
				}));
			}
			refetchContactGroups(qc, mailboxId);
			setRenaming(null);
		},
	});

	const remove = useMutation({
		mutationKey: contactGroupsWritesKey(mailboxId),
		mutationFn: (id: string) => deleteContactGroup(mailboxId, id),
		onSuccess: async (_data, id) => {
			await patchContactGroups(qc, mailboxId, (current) => {
				const membersByGroup = { ...current.membersByGroup };
				delete membersByGroup[id];
				return {
					groups: current.groups.filter((entry) => entry.id !== id),
					membersByGroup,
				};
			});
			refetchContactGroups(qc, mailboxId);
		},
	});

	function submitCreate(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// Synchronous recheck — the disabled prop only re-renders on mutation
		// state change, so a same-tick second submit could still slip through.
		if (qc.isMutating({ mutationKey: contactGroupsWritesKey(mailboxId) }) > 0) return;
		create.mutate(newName.trim());
	}

	function submitRename(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!renaming || qc.isMutating({ mutationKey: contactGroupsWritesKey(mailboxId) }) > 0) return;
		rename.mutate({ id: renaming.id, name: renameValue.trim() });
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button type="button" variant="outline" disabled={!mailboxId}>
					<Tags className="h-4 w-4" />
					{t("contactGroups.manage")}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("contactGroups.title")}</DialogTitle>
					<DialogDescription>{t("contactGroups.description")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<form className="flex gap-2" onSubmit={submitCreate}>
						<Input
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
							placeholder={t("contactGroups.namePlaceholder")}
							maxLength={100}
							aria-label={t("contactGroups.new")}
						/>
						<Button type="submit" disabled={!newName.trim() || busy}>
							{t("contactGroups.create")}
						</Button>
					</form>
					{create.isError && (
						<p role="alert" className="text-sm text-red-600">
							{create.error instanceof Error ? create.error.message : t("contactGroups.createFailed")}
						</p>
					)}
					{groupsQuery.isLoading && <Skeleton className="h-12 w-full rounded-2xl" />}
					{groupsQuery.isError && (
						<p role="alert" className="flex items-center gap-2 text-sm text-red-600">
							{groupsQuery.error instanceof Error ? groupsQuery.error.message : t("contactGroups.loadFailed")}
							<button
								type="button"
								className="underline underline-offset-2"
								onClick={() => groupsQuery.refetch()}
							>
								{t("undo.retry")}
							</button>
						</p>
					)}
					<div className="space-y-2">
						{groups.map((group) =>
							renaming?.id === group.id ? (
								<form
									key={group.id}
									className="flex items-center gap-2 rounded-2xl bg-neutral-50 px-4 py-3"
									onSubmit={submitRename}
								>
									<Input
										value={renameValue}
										onChange={(event) => setRenameValue(event.target.value)}
										maxLength={100}
										autoFocus
										aria-label={t("common.name")}
									/>
									<Button
										type="submit"
										size="icon"
										variant="ghost"
										disabled={!renameValue.trim() || busy}
										aria-label={t("common.save")}
									>
										<Check className="h-4 w-4" />
									</Button>
									<Button
										type="button"
										size="icon"
										variant="ghost"
										onClick={() => setRenaming(null)}
										aria-label={t("common.cancel")}
									>
										<X className="h-4 w-4" />
									</Button>
								</form>
							) : (
								<div
									key={group.id}
									className="flex items-center justify-between gap-3 rounded-2xl bg-neutral-50 px-4 py-3"
								>
									<div className="flex min-w-0 items-center gap-2">
										<p className="truncate text-sm font-semibold text-neutral-900">{group.name}</p>
										<Badge variant="secondary">
											{t("contactGroups.memberCount", { count: group.memberCount })}
										</Badge>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<Button
											type="button"
											size="icon"
											variant="ghost"
											aria-label={t("contactGroups.rename", { name: group.name })}
											disabled={busy}
											onClick={() => {
												setRenaming(group);
												setRenameValue(group.name);
											}}
										>
											<Pencil className="h-4 w-4" />
										</Button>
										<Button
											type="button"
											size="icon"
											variant="ghost"
											aria-label={t("contactGroups.deleteFor", { name: group.name })}
											disabled={busy}
											onClick={async () => {
												if (!await confirmDestructive(t("contactGroups.deleteConfirm", { name: group.name }))) return;
												// The confirmation awaited: another write may have started meanwhile.
												if (qc.isMutating({ mutationKey: contactGroupsWritesKey(mailboxId) }) > 0) return;
												remove.mutate(group.id);
											}}
										>
											<Trash2 className="h-4 w-4 text-red-600" />
										</Button>
									</div>
								</div>
							),
						)}
						{!groupsQuery.isLoading && !groupsQuery.isError && groups.length === 0 && (
							<p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
								{t("contactGroups.none")}
							</p>
						)}
					</div>
					{rename.isError && (
						<p role="alert" className="text-sm text-red-600">
							{rename.error instanceof Error ? rename.error.message : t("contactGroups.renameFailed")}
						</p>
					)}
					{remove.isError && (
						<p role="alert" className="text-sm text-red-600">
							{remove.error instanceof Error ? remove.error.message : t("contactGroups.deleteFailed")}
						</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
