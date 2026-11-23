"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { mobilePrimaryActionAboveNavClass } from "@/components/page-header-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createMailingList, fetchMailingListDomains, insertMailingListIntoIndex, refetchMailingListIndex } from "./utils";

export function ListCreateDialog() {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [domainId, setDomainId] = useState("");
	const [description, setDescription] = useState("");
	const [postingPolicy, setPostingPolicy] = useState<"members_only" | "anyone">("members_only");
	const [moderated, setModerated] = useState(false);

	const domains = useQuery({
		queryKey: ["domains"],
		queryFn: fetchMailingListDomains,
		enabled: open,
	});
	const activeDomains = (domains.data?.domains ?? []).filter((domain) => domain.status === "active");

	const create = useMutation({
		mutationFn: () =>
			createMailingList({
				domainId,
				localPart: localPart.trim(),
				name: name.trim(),
				description: description.trim() || undefined,
				postingPolicy,
				moderated,
			}),
		onSuccess: async ({ list }) => {
			insertMailingListIntoIndex(qc, list);
			await refetchMailingListIndex(qc);
			setOpen(false);
			setName("");
			setLocalPart("");
			setDomainId("");
			setDescription("");
			setPostingPolicy("members_only");
			setModerated(false);
		},
	});

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button className={mobilePrimaryActionAboveNavClass}>
					<Plus className="h-4 w-4" />
					{t("mailingLists.new")}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("mailingLists.createTitle")}</DialogTitle>
					<DialogDescription>{t("mailingLists.createDescription")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="list-name">{t("common.name")}</Label>
						<Input
							id="list-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("mailingLists.namePlaceholder")}
							maxLength={100}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="list-localpart">{t("mailingLists.address")}</Label>
						<div className="flex h-10 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-sm shadow-neutral-200/50 focus-within:border-blue-600">
							<Input
								id="list-localpart"
								value={localPart}
								onChange={(event) => setLocalPart(event.target.value)}
								placeholder={t("mailingLists.localPlaceholder")}
								maxLength={64}
								className="min-w-0 flex-1 rounded-none border-0 shadow-none focus-visible:border-0"
							/>
							<span className="flex items-center text-sm text-neutral-500">@</span>
							<Select
								aria-label={t("accounts.domain")}
								containerClassName="max-w-[55%] rounded-none border-0 p-0"
								className="h-full rounded-none border-0 bg-transparent px-3 text-sm text-neutral-700 shadow-none"
								value={domainId}
								onChange={(event) => setDomainId(event.target.value)}
							>
								<option value="">{t("accounts.selectDomain")}</option>
								{activeDomains.map((domain) => (
									<option key={domain.id} value={domain.id}>
										{domain.hostname}
									</option>
								))}
							</Select>
						</div>
					</div>
					{domains.isLoading && (
						<p className="text-sm text-neutral-500">{t("common.loading")}</p>
					)}
					{domains.isError && (
						<p role="alert" className="flex items-center gap-2 text-sm text-red-600">
							{domains.error instanceof Error ? domains.error.message : t("mailingLists.domainsLoadFailed")}
							<button
								type="button"
								className="underline underline-offset-2"
								onClick={() => domains.refetch()}
							>
								{t("undo.retry")}
							</button>
						</p>
					)}
					{domains.data && activeDomains.length === 0 && (
						<p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
							{t("mailingLists.noDomains")}
						</p>
					)}
					<div className="space-y-2">
						<Label htmlFor="list-description">{t("mailingLists.descriptionLabel")}</Label>
						<Textarea
							id="list-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder={t("mailingLists.descriptionPlaceholder")}
							maxLength={1000}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="list-policy">{t("mailingLists.postingPolicy")}</Label>
						<Select
							id="list-policy"
							value={postingPolicy}
							onChange={(event) => setPostingPolicy(event.target.value as "members_only" | "anyone")}
							containerClassName="flex w-full rounded-none border-0 p-0"
							className="h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600"
						>
							<option value="members_only">{t("mailingLists.policyMembersOnly")}</option>
							<option value="anyone">{t("mailingLists.policyAnyone")}</option>
						</Select>
					</div>
					<label className="flex items-start gap-3 text-sm">
						<Checkbox checked={moderated} onChange={(event) => setModerated(event.target.checked)} />
						<span>
							<strong>{t("mailingLists.moderated")}</strong>
							<span className="mt-1 block text-neutral-500">{t("mailingLists.moderatedHint")}</span>
						</span>
					</label>
					{create.isError && (
						<p role="alert" className="text-sm text-red-600">
							{create.error instanceof Error ? create.error.message : t("mailingLists.createFailed")}
						</p>
					)}
					<Button
						onClick={() => create.mutate()}
						disabled={!name.trim() || !domainId || !localPart.trim() || create.isPending}
					>
						{create.isPending ? t("accounts.creating") : t("mailingLists.createButton")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
