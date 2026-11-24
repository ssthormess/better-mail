"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, HardDrive, Mail, Paperclip } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDriveSize } from "@/lib/drive/utils";
import { formatUserDate } from "@/lib/time/utils";
import type { MailboxUsageCardProps } from "./mailbox-usage-card-types";
import { canViewMailboxUsage, fetchMailboxUsage, mailboxUsageQueryKey } from "./mailbox-usage-card-utils";

const COMPUTED_AT_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

export default function MailboxUsageCard({ mailboxId, permission }: MailboxUsageCardProps) {
	const { t } = useLanguage();
	const canManage = canViewMailboxUsage(permission);
	const usage = useQuery({
		queryKey: mailboxUsageQueryKey(mailboxId),
		queryFn: () => fetchMailboxUsage(mailboxId),
		enabled: !!mailboxId && canManage,
	});
	if (!canManage) return null;

	const breakdown = usage.data?.breakdown;
	const rows = breakdown
		? [
				{ icon: Mail, label: t("mailbox.usageMessages"), value: String(breakdown.messageCount) },
				{ icon: FileText, label: t("mailbox.usageBodies"), value: formatDriveSize(breakdown.bodyBytes) },
				{ icon: Paperclip, label: t("mailbox.usageAttachments"), value: formatDriveSize(breakdown.attachmentBytes) },
			]
		: [];

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>{t("mailbox.usage")}</CardTitle>
				<CardDescription>{t("mailbox.usageDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 pt-5">
				{usage.isLoading && <Skeleton className="h-28 w-full rounded-2xl" />}
				{usage.isError && (
					<p className="text-sm text-red-600">
						{usage.error instanceof Error ? usage.error.message : t("mailbox.usageLoadFailed")}
					</p>
				)}
				{usage.data && breakdown && breakdown.messageCount === 0 && (
					<p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
						{t("mailbox.usageEmpty")}
					</p>
				)}
				{usage.data && breakdown && breakdown.messageCount > 0 && (
					<div className="rounded-2xl bg-neutral-50 px-4 py-3">
						<div className="flex items-baseline justify-between gap-3">
							<p className="flex min-w-0 items-center gap-2 text-sm text-neutral-500">
								<HardDrive className="h-4 w-4 shrink-0 text-neutral-400" />
								{t("mailbox.usageTotal")}
							</p>
							<p className="shrink-0 text-xl font-medium text-neutral-900">
								{formatDriveSize(usage.data.storageUsed)}
							</p>
						</div>
						<dl className="mt-3 space-y-2 border-t border-neutral-200 pt-3">
							{rows.map((row) => (
								<div key={row.label} className="flex items-center justify-between gap-3">
									<dt className="flex min-w-0 items-center gap-2 text-sm text-neutral-500">
										<row.icon className="h-4 w-4 shrink-0 text-neutral-400" />
										{row.label}
									</dt>
									<dd className="shrink-0 text-sm font-medium text-neutral-900">{row.value}</dd>
								</div>
							))}
						</dl>
					</div>
				)}
				{usage.data && (
					<p className="text-xs text-neutral-400">
						{t("mailbox.usageComputedAt", {
							date: formatUserDate(usage.data.computedAt, COMPUTED_AT_FORMAT),
						})}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
