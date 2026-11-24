"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FEED_DEFAULT_INTERVAL_SEC, FEED_INTERVAL_PRESETS_SEC, feedErrorMessage, feedIntervalLabel } from "./feeds-utils";
import type { FeedsAddFormProps } from "./feeds-types";

export function FeedsAddForm({ onAdd }: FeedsAddFormProps) {
	const { t } = useLanguage();
	const [url, setUrl] = useState("");
	const [title, setTitle] = useState("");
	const [interval, setInterval] = useState(String(FEED_DEFAULT_INTERVAL_SEC));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<{ message: string; detail?: string } | null>(null);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			const result = await onAdd({ url: url.trim(), title: title.trim() || undefined, refreshIntervalSec: Number(interval) });
			setUrl("");
			setTitle("");
			toast.success(t("calendar.feeds.added", { title: result.subscription.title }));
			if (result.errors.length) toast.error(t("calendar.feeds.someSkipped", { count: result.errors.length }));
		} catch (addError) {
			setError(feedErrorMessage(addError, t, t("calendar.feeds.addFailed")));
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="space-y-3">
			<div>
				<label htmlFor="feed-url" className="mb-1 block text-sm font-medium text-neutral-700">{t("calendar.feeds.urlLabel")}</label>
				<Input id="feed-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t("calendar.feeds.urlPlaceholder")} disabled={pending} autoComplete="off" inputMode="url" required />
				<p className="mt-1 text-xs text-neutral-500">{t("calendar.feeds.urlHint")}</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div>
					<label htmlFor="feed-title" className="mb-1 block text-sm font-medium text-neutral-700">{t("calendar.feeds.nameLabel")}</label>
					<Input id="feed-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} autoComplete="off" maxLength={200} />
				</div>
				<div>
					<label htmlFor="feed-interval" className="mb-1 block text-sm font-medium text-neutral-700">{t("calendar.feeds.intervalLabel")}</label>
					<Select id="feed-interval" value={interval} onChange={(event) => setInterval(event.target.value)} disabled={pending} containerClassName="contents" className="h-10 w-full rounded-md border border-neutral-200 px-3 text-sm text-neutral-700 shadow-sm shadow-neutral-200/50">
						{FEED_INTERVAL_PRESETS_SEC.map((seconds) => <option key={seconds} value={seconds}>{feedIntervalLabel(seconds, t)}</option>)}
					</Select>
				</div>
			</div>
			{error && (
				<div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
					<p>{error.message}</p>
					{error.detail && <p className="mt-0.5 text-xs text-red-600">{error.detail}</p>}
				</div>
			)}
			<Button type="submit" disabled={pending || !url.trim()}>{pending ? t("calendar.feeds.subscribing") : t("calendar.feeds.subscribe")}</Button>
		</form>
	);
}
