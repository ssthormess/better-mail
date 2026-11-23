"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Save } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { MailingList } from "../types";
import type { MailingListDetailResponse } from "./types";
import { updateMailingList } from "./utils";

export function ListDetailsCard({ list }: { list: MailingList }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const [enabled, setEnabled] = useState(!list.disabled);
	const [name, setName] = useState(list.name);
	const [description, setDescription] = useState(list.description ?? "");
	const [postingPolicy, setPostingPolicy] = useState(list.postingPolicy);
	const [moderated, setModerated] = useState(list.moderated);

	// Copy each newly loaded (or freshly saved) list into the form fields.
	const [syncedList, setSyncedList] = useState(list);
	if (list !== syncedList) {
		setSyncedList(list);
		setEnabled(!list.disabled);
		setName(list.name);
		setDescription(list.description ?? "");
		setPostingPolicy(list.postingPolicy);
		setModerated(list.moderated);
	}

	const update = useMutation({
		mutationFn: () =>
			updateMailingList(list.id, {
				name: name.trim(),
				description: description.trim() || null,
				postingPolicy,
				moderated,
				disabled: !enabled,
			}),
		onSuccess: ({ list: updated }) => {
			qc.setQueryData<MailingListDetailResponse>(["mailing-list", list.id], (current) =>
				current ? { ...current, list: { ...current.list, ...updated } } : current,
			);
			qc.invalidateQueries({ queryKey: ["mailing-lists"] });
		},
	});

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>{t("mailingLists.detailsTitle")}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4 pt-5">
				<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
					<Checkbox
						checked={enabled}
						onChange={(event) => setEnabled(event.target.checked)}
						disabled={update.isPending}
					/>
					<span>
						<span className="block text-sm font-medium text-neutral-900">{t("mailingLists.enabled")}</span>
						<span className="mt-1 block text-sm text-neutral-500">{t("mailingLists.enabledHint")}</span>
					</span>
				</label>
				<div className="space-y-2">
					<Label htmlFor="list-edit-name">{t("common.name")}</Label>
					<Input
						id="list-edit-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={100}
						disabled={update.isPending}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="list-edit-description">{t("mailingLists.descriptionLabel")}</Label>
					<Textarea
						id="list-edit-description"
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						placeholder={t("mailingLists.descriptionPlaceholder")}
						maxLength={1000}
						disabled={update.isPending}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="list-edit-policy">{t("mailingLists.postingPolicy")}</Label>
					<Select
						id="list-edit-policy"
						value={postingPolicy}
						onChange={(event) => setPostingPolicy(event.target.value as MailingList["postingPolicy"])}
						disabled={update.isPending}
						containerClassName="flex w-full rounded-none border-0 p-0"
						className="h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600"
					>
						<option value="members_only">{t("mailingLists.policyMembersOnly")}</option>
						<option value="anyone">{t("mailingLists.policyAnyone")}</option>
					</Select>
				</div>
				<label className="flex items-start gap-3 text-sm">
					<Checkbox
						checked={moderated}
						onChange={(event) => setModerated(event.target.checked)}
						disabled={update.isPending}
					/>
					<span>
						<strong>{t("mailingLists.moderated")}</strong>
						<span className="mt-1 block text-neutral-500">{t("mailingLists.moderatedHint")}</span>
					</span>
				</label>
				{update.isError && (
					<p role="alert" className="text-sm text-red-600">
						{update.error instanceof Error ? update.error.message : t("mailingLists.updateFailed")}
					</p>
				)}
				{update.isSuccess && <p className="text-sm text-green-700">{t("mailingLists.saved")}</p>}
				<Button onClick={() => update.mutate()} disabled={!name.trim() || update.isPending}>
					<Save className="h-4 w-4" />
					{update.isPending ? t("common.saving") : t("settings.mailbox.saveChanges")}
				</Button>
			</CardContent>
		</Card>
	);
}
