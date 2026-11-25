"use client";

import { Globe2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { FeedEditRow } from "./feed-edit-row";
import { FeedRow } from "./feed-row";
import type { FeedsListProps } from "./feeds-types";

function FeedsListSkeleton() {
	return (
		<div className="space-y-2" aria-hidden="true">
			{[0, 1, 2].map((index) => (
				<div key={index} className="rounded-xl border border-neutral-200 px-4 py-3">
					<Skeleton className="h-4 w-2/5" />
					<Skeleton className="mt-2 h-3 w-3/5" />
					<Skeleton className="mt-2 h-3 w-1/2" />
				</div>
			))}
		</div>
	);
}

export function FeedsList({ subscriptions, loadError, denied, editingId, pendingId, onRetry, onEdit, onCancelEdit, onSave, onDelete }: FeedsListProps) {
	const { t } = useLanguage();

	if (denied) {
		return (
			<p role="alert" className="flex items-center gap-2 text-sm text-red-600">
				{t("calendar.feeds.unavailable")}
				<button type="button" className="underline underline-offset-2" onClick={onRetry}>{t("undo.retry")}</button>
			</p>
		);
	}
	if (loadError) {
		return (
			<p role="alert" className="flex items-center gap-2 text-sm text-red-600">
				{t("calendar.feeds.loadFailed")}
				<button type="button" className="underline underline-offset-2" onClick={onRetry}>{t("undo.retry")}</button>
			</p>
		);
	}
	if (subscriptions === null) return <FeedsListSkeleton />;
	if (!subscriptions.length) {
		return (
			<div className="rounded-2xl border border-dashed border-neutral-300 px-6 py-8 text-center">
				<Globe2 className="mx-auto mb-2 h-7 w-7 text-neutral-400" />
				<h3 className="text-sm font-medium text-neutral-900">{t("calendar.feeds.none")}</h3>
				<p className="mt-1 text-sm text-neutral-500">{t("calendar.feeds.noneHint")}</p>
			</div>
		);
	}
	return (
		<div className="space-y-2">
			{subscriptions.map((subscription) => editingId === subscription.id ? (
				<FeedEditRow key={subscription.id} subscription={subscription} pending={pendingId === subscription.id}
					onSave={(patch) => onSave(subscription.id, patch)} onCancel={onCancelEdit} />
			) : (
				<FeedRow key={subscription.id} subscription={subscription} pending={pendingId === subscription.id}
					onEdit={() => onEdit(subscription.id)} onDelete={() => onDelete(subscription)} />
			))}
		</div>
	);
}
