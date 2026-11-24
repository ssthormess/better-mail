"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ListDangerCard } from "./list-danger-card";
import { ListDetailsCard } from "./list-details-card";
import { ListMembersCard } from "./list-members-card";
import { fetchMailingList } from "./utils";

export default function MailingListDetailPage() {
	const { t } = useLanguage();
	const params = useParams<{ id: string }>();
	const listId = params.id;

	const detail = useQuery({
		queryKey: ["mailing-list", listId],
		queryFn: () => fetchMailingList(listId),
		enabled: !!listId,
	});

	const list = detail.data?.list;

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h1 className="truncate text-2xl md:text-3xl font-medium text-neutral-900">
						{list?.name ?? t("mailingLists.title")}
					</h1>
					{list ? (
						<p className="mt-1 truncate no-font-mono text-sm text-neutral-500">{list.address}</p>
					) : (
						!detail.isError && <Skeleton className="mt-2 h-4 w-52" />
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{list?.disabled && <Badge variant="secondary">{t("accounts.status.disabled")}</Badge>}
					{list?.moderated && <Badge variant="secondary">{t("mailingLists.moderated")}</Badge>}
					{list && (
						<Badge variant="secondary">
							{list.postingPolicy === "anyone"
								? t("mailingLists.policyAnyone")
								: t("mailingLists.policyMembersOnly")}
						</Badge>
					)}
				</div>
			</div>

			{detail.isError && (
				<p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
					{detail.error instanceof Error ? detail.error.message : t("mailingLists.loadFailed")}
				</p>
			)}

			{list && (
				<>
					<ListDetailsCard list={list} />
					<ListMembersCard listId={list.id} members={detail.data?.members ?? []} loading={detail.isLoading} />
					<ListDangerCard list={list} />
				</>
			)}
		</div>
	);
}
