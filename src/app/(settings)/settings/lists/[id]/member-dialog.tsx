"use client";

import { useEffect, useRef, useState } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { MailingListMember } from "../types";
import { refetchMailingListIndex, updateMailingListInIndex } from "../utils";
import { addMailingListMember, mailingListWritesKey, patchMailingListDetail, updateMailingListMember } from "./utils";

type MemberDialogProps = {
	listId: string;
	member?: MailingListMember;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Forwarded to DialogContent — the card uses it to return focus to the opener. */
	onCloseAutoFocus?: (event: Event) => void;
};

export function MemberDialog({ listId, member, open, onOpenChange, onCloseAutoFocus }: MemberDialogProps) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const editing = !!member;
	const [email, setEmail] = useState(member?.email ?? "");
	const [name, setName] = useState(member?.name ?? "");
	const [role, setRole] = useState<"owner" | "member">(member?.role ?? "member");
	const [moderated, setModerated] = useState(member?.moderated ?? false);

	// Member writes and the list delete share one mutation scope — while any is in
	// flight the others wait, so arrival order can't undo a newer snapshot.
	const memberBusy = useIsMutating({ mutationKey: mailingListWritesKey(listId) }) > 0;
	// A pending save can outlive the dialog: only close when this instance is still
	// open. The parent remounts the dialog on every open, so the unmount cleanup
	// also stops a stale save from closing its successor.
	const openRef = useRef(open);
	useEffect(() => {
		openRef.current = open;
		return () => {
			openRef.current = false;
		};
	}, [open]);

	const save = useMutation({
		mutationKey: mailingListWritesKey(listId),
		mutationFn: async (): Promise<MailingListMember[]> => {
			if (editing) {
				return updateMailingListMember(listId, member.id, {
					name: name.trim() || null,
					role,
					moderated,
				});
			}
			return addMailingListMember(listId, {
				email: email.trim(),
				name: name.trim() || undefined,
				role,
				moderated,
			});
		},
		onSuccess: async (members) => {
			await patchMailingListDetail(qc, listId, (current) => ({
				list: { ...current.list, memberCount: members.length },
				members,
			}));
			updateMailingListInIndex(qc, { id: listId, memberCount: members.length });
			refetchMailingListIndex(qc);
			if (openRef.current) onOpenChange(false);
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent onCloseAutoFocus={onCloseAutoFocus}>
				<DialogHeader>
					<DialogTitle>{editing ? t("mailingLists.editMemberTitle") : t("mailingLists.addMember")}</DialogTitle>
					<DialogDescription>{t("mailingLists.membersDescription")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="member-email">{t("mailboxes.emailAddress")}</Label>
						<Input
							id="member-email"
							type="email"
							value={editing ? member.email : email}
							onChange={(event) => setEmail(event.target.value)}
							placeholder={t("mailingLists.memberEmailPlaceholder")}
							disabled={editing}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="member-name">{t("common.name")}</Label>
						<Input
							id="member-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("mailingLists.memberNamePlaceholder")}
							maxLength={100}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="member-role">{t("accounts.role")}</Label>
						<Select
							id="member-role"
							value={role}
							onChange={(event) => setRole(event.target.value as "owner" | "member")}
							containerClassName="flex w-full rounded-none border-0 p-0"
							className="h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600"
						>
							<option value="member">{t("mailingLists.roleMember")}</option>
							<option value="owner">{t("mailingLists.roleOwner")}</option>
						</Select>
					</div>
					<label className="flex items-start gap-3 text-sm">
						<Checkbox checked={moderated} onChange={(event) => setModerated(event.target.checked)} />
						<span>
							<strong>{t("mailingLists.moderated")}</strong>
							<span className="mt-1 block text-neutral-500">{t("mailingLists.memberModeratedHint")}</span>
						</span>
					</label>
					{save.isError && (
						<p role="alert" className="text-sm text-red-600">
							{save.error instanceof Error
								? save.error.message
								: t(editing ? "mailingLists.memberUpdateFailed" : "mailingLists.memberAddFailed")}
						</p>
					)}
					<Button
						onClick={() => {
							// Synchronous recheck — the disabled prop only re-renders on mutation
							// state change, so a same-tick second save could still slip through.
							if (qc.isMutating({ mutationKey: mailingListWritesKey(listId) }) > 0) return;
							save.mutate();
						}}
						disabled={(!editing && !email.trim()) || memberBusy}
					>
						{save.isPending ? t("common.saving") : t("common.save")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
