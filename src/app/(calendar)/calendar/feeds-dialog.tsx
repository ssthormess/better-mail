"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import { readFeedResponse } from "./feeds-utils";
import { FeedsAddForm } from "./feeds-add-form";
import { FeedsList } from "./feeds-list";
import type { CalendarFeedsDialogProps, CalendarSubscription, SubscriptionCreateInput, SubscriptionCreateResult, SubscriptionPatchInput } from "./feeds-types";

export function CalendarFeedsDialog({ open, onOpenChange, onChanged }: CalendarFeedsDialogProps) {
	const { t } = useLanguage();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-4rem)] w-[min(640px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("calendar.feeds.title")}</DialogTitle>
					<DialogDescription>{t("calendar.feeds.description")}</DialogDescription>
				</DialogHeader>
				<FeedsPanel onChanged={onChanged} />
			</DialogContent>
		</Dialog>
	);
}

/**
 * The dialog's working body. Radix unmounts dialog content while closed, so this mounts fresh on
 * every open — the GET fires once on mount and all per-visit state resets for free.
 */
function FeedsPanel({ onChanged }: { onChanged?: () => void }) {
	const { t } = useLanguage();
	const [subscriptions, setSubscriptions] = useState<CalendarSubscription[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void authFetch("/api/calendar/subscriptions")
			.then(async (response) => {
				const body = await response.json().catch(() => ({})) as { subscriptions?: CalendarSubscription[] };
				if (!response.ok || !Array.isArray(body.subscriptions)) throw new Error();
				if (active) setSubscriptions(body.subscriptions);
			})
			.catch(() => { if (active) { setSubscriptions([]); setLoadError(true); } });
		return () => { active = false; };
	}, [reloadKey]);

	async function add(input: SubscriptionCreateInput): Promise<SubscriptionCreateResult> {
		const response = await authFetch("/api/calendar/subscriptions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const failure = await readFeedResponse(response);
		if (failure) throw failure;
		const result = await response.json() as SubscriptionCreateResult;
		setSubscriptions((current) => [...(current ?? []), result.subscription]);
		onChanged?.();
		return result;
	}

	async function save(id: string, patch: SubscriptionPatchInput): Promise<CalendarSubscription> {
		setPendingId(id);
		try {
			const response = await authFetch(`/api/calendar/subscriptions/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			const failure = await readFeedResponse(response);
			if (failure) throw failure;
			const { subscription } = await response.json() as { subscription: CalendarSubscription };
			setSubscriptions((current) => current?.map((item) => item.id === id ? subscription : item) ?? null);
			setEditingId(null);
			return subscription;
		} finally {
			setPendingId(null);
		}
	}

	async function remove(subscription: CalendarSubscription) {
		if (!await confirmDestructive(t("calendar.feeds.deleteConfirm", { title: subscription.title }))) return;
		setPendingId(subscription.id);
		try {
			const response = await authFetch(`/api/calendar/subscriptions/${subscription.id}`, { method: "DELETE" });
			if (!response.ok) throw new Error();
			setSubscriptions((current) => current?.filter((item) => item.id !== subscription.id) ?? null);
			onChanged?.();
		} catch {
			toast.error(t("calendar.feeds.deleteFailed"));
		} finally {
			setPendingId(null);
		}
	}

	return (
		<>
			<FeedsAddForm onAdd={add} />
			<div className="mt-5 border-t border-neutral-200 pt-4">
				<FeedsList subscriptions={subscriptions} loadError={loadError} editingId={editingId} pendingId={pendingId}
					onRetry={() => { setLoadError(false); setSubscriptions(null); setReloadKey((key) => key + 1); }}
					onEdit={setEditingId} onCancelEdit={() => setEditingId(null)} onSave={save} onDelete={(subscription) => void remove(subscription)} />
			</div>
		</>
	);
}
