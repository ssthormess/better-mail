"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Users } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { List, ListRow } from "@/components/ui/list";
import { ListCreateDialog } from "./list-create-dialog";
import { fetchMailingLists } from "./utils";

const COLUMNS =
	"grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]";

export default function MailingListsPage() {
	const { t } = useLanguage();
	const lists = useQuery({
		queryKey: ["mailing-lists"],
		queryFn: fetchMailingLists,
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl md:text-3xl font-medium">{t("mailingLists.title")}</h1>
				<ListCreateDialog />
			</div>
			<p className="text-sm text-neutral-500">{t("mailingLists.description")}</p>
			{lists.isError && (
				<p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
					{lists.error instanceof Error ? lists.error.message : t("mailingLists.loadFailed")}
				</p>
			)}
			<section className="space-y-3">
				{lists.isLoading && <SectionRowSkeleton />}
				{!lists.isLoading && !lists.isError && (lists.data?.lists ?? []).length === 0 && (
					<p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">
						{t("mailingLists.none")}
					</p>
				)}
				<List>
					<div className={`${COLUMNS} bg-white px-5 py-3 text-xs font-medium uppercase text-neutral-500`}>
						<span className="w-10" />
						<span>{t("common.name")}</span>
						<span className="hidden md:block">{t("mailingLists.postingPolicy")}</span>
						<span className="hidden md:block">{t("mailingLists.membersTitle")}</span>
					</div>
					{(lists.data?.lists ?? []).map((list) => (
						<ListRow key={list.id} asChild className={`${COLUMNS} px-5 py-4`}>
							<Link
								href={`/settings/lists/${list.id}`}
								className="group transition-colors hover:bg-blue-50/40"
							>
								<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
									<Users className="h-5 w-5" />
								</span>
								<span className="min-w-0">
									<span className="flex min-w-0 items-center gap-2">
										<span className="block truncate text-sm font-semibold text-neutral-900">
											{list.name}
										</span>
										{list.disabled && (
											<span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
												{t("accounts.status.disabled")}
											</span>
										)}
										{list.moderated && (
											<span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
												{t("mailingLists.moderated")}
											</span>
										)}
									</span>
									<span className="block truncate no-font-mono text-sm text-neutral-500">
										{list.address}
									</span>
								</span>
								<span className="hidden md:block">
									<span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
										{list.postingPolicy === "anyone"
											? t("mailingLists.policyAnyone")
											: t("mailingLists.policyMembersOnly")}
									</span>
								</span>
								<span className="hidden text-sm text-neutral-500 md:block">
									{t("mailingLists.memberCount", { count: list.memberCount })}
								</span>
							</Link>
						</ListRow>
					))}
				</List>
			</section>
		</div>
	);
}
