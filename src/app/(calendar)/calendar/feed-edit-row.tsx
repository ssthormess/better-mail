"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FEED_INTERVAL_PRESETS_SEC, feedErrorMessage, feedIntervalLabel } from "./feeds-utils";
import type { FeedEditRowProps } from "./feeds-types";

export function FeedEditRow({ subscription, pending, onSave, onCancel }: FeedEditRowProps) {
	const { t } = useLanguage();
	const [title, setTitle] = useState(subscription.title);
	const [interval, setInterval] = useState(String(subscription.refreshIntervalSec));
	const [error, setError] = useState<{ message: string; detail?: string } | null>(null);

	// A custom interval saved through the API stays selectable rather than silently snapping to a preset.
	const options = FEED_INTERVAL_PRESETS_SEC.includes(subscription.refreshIntervalSec)
		? FEED_INTERVAL_PRESETS_SEC
		: [...FEED_INTERVAL_PRESETS_SEC, subscription.refreshIntervalSec].sort((a, b) => a - b);
	const dirty = title.trim() !== subscription.title || Number(interval) !== subscription.refreshIntervalSec;

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		try {
			const patch: { title?: string; refreshIntervalSec?: number } = {};
			if (title.trim() !== subscription.title) patch.title = title.trim();
			if (Number(interval) !== subscription.refreshIntervalSec) patch.refreshIntervalSec = Number(interval);
			await onSave(patch);
		} catch (saveError) {
			setError(feedErrorMessage(saveError, t, t("calendar.feeds.saveFailed")));
		}
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 px-4 py-3">
			<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-neutral-700">{t("calendar.feeds.nameLabel")}</span>
					<Input value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} autoComplete="off" maxLength={200} required />
				</label>
				<label className="block text-sm">
					<span className="mb-1 block font-medium text-neutral-700">{t("calendar.feeds.intervalLabel")}</span>
					<Select value={interval} onChange={(event) => setInterval(event.target.value)} disabled={pending} containerClassName="contents" className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-700 shadow-sm shadow-neutral-200/50">
						{options.map((seconds) => <option key={seconds} value={seconds}>{feedIntervalLabel(seconds, t)}</option>)}
					</Select>
				</label>
			</div>
			{error && (
				<div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
					<p>{error.message}</p>
					{error.detail && <p className="mt-0.5 text-xs text-red-600">{error.detail}</p>}
				</div>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>{t("common.cancel")}</Button>
				<Button type="submit" disabled={pending || !dirty}>{pending ? t("common.saving") : t("common.save")}</Button>
			</div>
		</form>
	);
}
