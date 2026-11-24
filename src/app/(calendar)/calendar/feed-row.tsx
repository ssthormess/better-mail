"use client";

import clsx from "clsx";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock, Pencil, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import { feedHealth, feedIntervalLabel, feedUrlLabel } from "./feeds-utils";
import type { FeedRowProps } from "./feeds-types";

const HEALTH_ICONS = {
	ok: { icon: CheckCircle2, className: "text-emerald-600" },
	warning: { icon: AlertTriangle, className: "text-amber-500" },
	error: { icon: AlertCircle, className: "text-red-600" },
	pending: { icon: Clock, className: "text-neutral-400" },
} as const;

export function FeedRow({ subscription, pending, onEdit, onDelete }: FeedRowProps) {
	const { t } = useLanguage();
	const health = feedHealth(subscription);
	const { icon: HealthIcon, className: healthClass } = HEALTH_ICONS[health];

	return (
		<div className="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3">
			<HealthIcon aria-hidden="true" className={clsx("mt-0.5 h-4 w-4 shrink-0", healthClass)} />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-neutral-900">{subscription.title}</p>
				<p className="truncate text-xs text-neutral-500" title={subscription.feedUrl}>{feedUrlLabel(subscription.feedUrl)}</p>
				<p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-neutral-500">
					<span>{t("calendar.feeds.eventCount", { count: subscription.eventCount })}</span>
					<span aria-hidden="true">·</span>
					<span>{feedIntervalLabel(subscription.refreshIntervalSec, t)}</span>
					<span aria-hidden="true">·</span>
					<span>{subscription.lastRefreshAt ? t("calendar.feeds.lastChecked", { time: formatUserDate(subscription.lastRefreshAt, { dateStyle: "medium", timeStyle: "short" }) }) : t("calendar.feeds.neverChecked")}</span>
				</p>
				{subscription.lastError && (
					<p className={clsx("mt-1.5 text-xs", health === "error" ? "text-red-600" : "text-amber-700")}>{subscription.lastError}</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<button type="button" disabled={pending} onClick={onEdit} aria-label={t("calendar.feeds.editAria", { title: subscription.title })} className="rounded-full p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40">
					<Pencil className="h-4 w-4" />
				</button>
				<button type="button" disabled={pending} onClick={onDelete} aria-label={t("calendar.feeds.deleteAria", { title: subscription.title })} className="rounded-full p-2 text-neutral-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40">
					<Trash2 className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
}
