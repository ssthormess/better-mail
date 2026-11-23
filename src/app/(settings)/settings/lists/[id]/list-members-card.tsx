"use client";

import { useRef, useState } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, UserPlus } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { MailingListMember } from "../types";
import { refetchMailingListIndex, updateMailingListInIndex } from "../utils";
import { MemberDialog, memberMutationKey } from "./member-dialog";
import type { MailingListDetailResponse } from "./types";
import { removeMailingListMember } from "./utils";

type ListMembersCardProps = {
	listId: string;
	members: MailingListMember[];
	loading: boolean;
};

export function ListMembersCard({ listId, members, loading }: ListMembersCardProps) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const [dialogMember, setDialogMember] = useState<MailingListMember | undefined>(undefined);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogKey, setDialogKey] = useState(0);
	const openerRef = useRef<HTMLElement | null>(null);

	// Member writes are serialized on one mutation key so an earlier snapshot arriving
	// last can never overwrite a newer one.
	const memberBusy = useIsMutating({ mutationKey: memberMutationKey(listId) }) > 0;

	const remove = useMutation({
		mutationKey: memberMutationKey(listId),
		mutationFn: (memberId: string) => removeMailingListMember(listId, memberId),
		onSuccess: async (updated) => {
			await qc.cancelQueries({ queryKey: ["mailing-list", listId] });
			qc.setQueryData<MailingListDetailResponse>(["mailing-list", listId], (current) =>
				current ? { list: { ...current.list, memberCount: updated.length }, members: updated } : current,
			);
			updateMailingListInIndex(qc, { id: listId, memberCount: updated.length });
			refetchMailingListIndex(qc);
		},
	});

	function openDialog(member: MailingListMember | undefined, opener: HTMLElement | null) {
		openerRef.current = opener;
		setDialogMember(member);
		setDialogKey((key) => key + 1);
		setDialogOpen(true);
	}

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<div className="flex items-center justify-between gap-4">
					<CardTitle>{t("mailingLists.membersTitle")}</CardTitle>
					<Button type="button" size="sm" variant="outline" disabled={memberBusy} onClick={(event) => openDialog(undefined, event.currentTarget)}>
						<UserPlus className="h-4 w-4" />
						{t("mailingLists.addMember")}
					</Button>
				</div>
				<CardDescription>{t("mailingLists.membersDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 pt-5">
				{loading && <Skeleton className="h-12 w-full rounded-2xl" />}
				{members.map((member) => (
					<div
						key={member.id}
						className="flex items-center justify-between gap-3 rounded-2xl bg-neutral-50 px-4 py-3"
					>
						<div className="flex min-w-0 items-center gap-2">
							<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
								{(member.name?.trim() || member.email).charAt(0).toUpperCase()}
							</span>
							<div className="min-w-0">
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<p className="truncate text-sm font-semibold text-neutral-900">{member.email}</p>
									{member.role === "owner" && (
										<Badge variant="secondary">{t("mailingLists.roleOwner")}</Badge>
									)}
									{member.moderated && (
										<Badge variant="secondary">{t("mailingLists.moderated")}</Badge>
									)}
								</div>
								{member.name && (
									<p className="truncate text-xs text-neutral-500">{member.name}</p>
								)}
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-1">
							<Button
								type="button"
								size="icon"
								variant="ghost"
								aria-label={t("mailingLists.editMember", { email: member.email })}
								disabled={memberBusy}
								onClick={(event) => openDialog(member, event.currentTarget)}
							>
								<Pencil className="h-4 w-4" />
							</Button>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								aria-label={t("mailingLists.removeMember", { email: member.email })}
								disabled={memberBusy}
								onClick={async () => {
									if (!await confirmDestructive(t("mailingLists.removeMemberConfirm", { email: member.email }))) return;
									remove.mutate(member.id);
								}}
							>
								<Trash2 className="h-4 w-4 text-red-600" />
							</Button>
						</div>
					</div>
				))}
				{!loading && members.length === 0 && (
					<p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
						{t("mailingLists.noMembers")}
					</p>
				)}
				{remove.isError && (
					<p role="alert" className="text-sm text-red-600">
						{remove.error instanceof Error ? remove.error.message : t("mailingLists.memberRemoveFailed")}
					</p>
				)}
			</CardContent>
			<MemberDialog
				key={dialogKey}
				listId={listId}
				member={dialogMember}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					openerRef.current?.focus();
				}}
			/>
		</Card>
	);
}
