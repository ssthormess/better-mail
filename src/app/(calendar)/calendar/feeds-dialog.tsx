"use client";

import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import { readFeedResponse } from "./feeds-utils";
import { FeedsAddForm } from "./feeds-add-form";
import { FeedsList } from "./feeds-list";
import type { CalendarFeedsDialogProps, CalendarSubscription, SubscriptionCreateInput, SubscriptionCreateResult, SubscriptionPatchInput } from "./feeds-types";

export function CalendarFeedsDialog({ open, onOpenChange, onChanged, returnFocusRef }: CalendarFeedsDialogProps) {
	const { t } = useLanguage();
	// Recent elements focused outside any dialog, oldest → newest. Opened from the options menu,
	// the menu item the dialog stole focus from unmounts without Radix ever restoring the trigger,
	// so close restores the newest still-connected entry — the menu's trigger button.
	const outsideFocusRef = useRef<HTMLElement[]>([]);
	useEffect(() => {
		const record = (event: FocusEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement) || target.closest("[role='dialog']")) return;
			const log = outsideFocusRef.current;
			log.push(target);
			if (log.length > 8) log.shift();
		};
		document.addEventListener("focusin", record, true);
		return () => document.removeEventListener("focusin", record, true);
	}, []);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				onCloseAutoFocus={(event) => {
					// Without an explicit target Radix drops focus on <body>; hand it back to the
					// newest outside element still in the document (the Calendar options button).
					const target = returnFocusRef?.current ?? [...outsideFocusRef.current].reverse().find((el) => el.isConnected && el !== document.body);
					if (!target) return;
					event.preventDefault();
					target.focus();
				}}
				className="max-h-[calc(100dvh-4rem)] w-[min(640px,calc(100vw-32px))] overflow-y-auto">
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
	/** The account lost the calendar feature mid-session; mutations stay hidden. */
	const [denied, setDenied] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	// Bumped when a mutation starts. A list GET whose flight overlaps any write — started earlier,
	// still in flight, or already journaled — can resolve with a snapshot that predates the write,
	// so it is reconciled with the recorded results instead of applied raw.
	const writeSeq = useRef(0);
	const writesInFlight = useRef(0);
	// Completed mutations an in-flight GET may not know about: rows written by add()/save() and
	// ids removed by remove(). Entries accumulate for the dialog's lifetime — they are tiny and a
	// clean (non-overlapping) snapshot resets them.
	const pendingWrites = useRef<{ upserted: Map<string, CalendarSubscription>; deleted: Set<string> }>({ upserted: new Map(), deleted: new Set() });

	useEffect(() => {
		let active = true;
		const seqAtStart = writeSeq.current;
		void authFetch("/api/calendar/subscriptions")
			.then(async (response) => {
				const body = await response.json().catch(() => ({})) as { subscriptions?: CalendarSubscription[] };
				if (!response.ok || !Array.isArray(body.subscriptions)) {
					const failure = new Error() as Error & { status?: number };
					failure.status = response.status;
					throw failure;
				}
				if (!active) return;
				const list = body.subscriptions;
				const { upserted, deleted } = pendingWrites.current;
				// A snapshot is only clean when no write overlapped this GET at all: none started
				// during its flight (seq unchanged), none still in flight, none already journaled
				// (a write that began before the GET but landed after its snapshot was taken).
				if (writeSeq.current !== seqAtStart || writesInFlight.current > 0 || upserted.size > 0 || deleted.size > 0) {
					// Merge the recorded mutation results over the stale snapshot — the journal
					// stays until a later load resolves clean, so repeated retries can't lose it.
					setSubscriptions(
						list
							.filter((item) => !deleted.has(item.id))
							.map((item) => upserted.get(item.id) ?? item)
							.concat([...upserted.values()].filter((item) => !list.some((row) => row.id === item.id))),
					);
					return;
				}
				pendingWrites.current.upserted.clear();
				pendingWrites.current.deleted.clear();
				setSubscriptions(list);
			})
			.catch((error: unknown) => {
				if (!active) return;
				if ((error as { status?: number }).status === 403) setDenied(true);
				// Keep whatever rows are already known — a failed retry must not hide data the
				// user just wrote; only an empty list falls back to the bare error block.
				setSubscriptions((current) => current ?? []);
				setLoadError(true);
			});
		return () => { active = false; };
	}, [reloadKey]);

	async function add(input: SubscriptionCreateInput): Promise<SubscriptionCreateResult> {
		writeSeq.current += 1;
		writesInFlight.current += 1;
		try {
			const response = await authFetch("/api/calendar/subscriptions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			const failure = await readFeedResponse(response);
			if (failure) throw failure;
			const result = await response.json() as SubscriptionCreateResult;
			pendingWrites.current.upserted.set(result.subscription.id, result.subscription);
			pendingWrites.current.deleted.delete(result.subscription.id);
			setSubscriptions((current) => [...(current ?? []).filter((item) => item.id !== result.subscription.id), result.subscription]);
			onChanged?.();
			return result;
		} finally {
			writesInFlight.current -= 1;
		}
	}

	async function save(id: string, patch: SubscriptionPatchInput): Promise<CalendarSubscription> {
		writeSeq.current += 1;
		writesInFlight.current += 1;
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
			pendingWrites.current.upserted.set(subscription.id, subscription);
			setSubscriptions((current) => current?.map((item) => item.id === id ? subscription : item) ?? null);
			setEditingId(null);
			return subscription;
		} finally {
			writesInFlight.current -= 1;
			setPendingId(null);
		}
	}

	async function remove(subscription: CalendarSubscription) {
		if (!await confirmDestructive(t("calendar.feeds.deleteConfirm", { title: subscription.title }))) return;
		writeSeq.current += 1;
		writesInFlight.current += 1;
		setPendingId(subscription.id);
		try {
			const response = await authFetch(`/api/calendar/subscriptions/${subscription.id}`, { method: "DELETE" });
			if (!response.ok) throw new Error();
			pendingWrites.current.upserted.delete(subscription.id);
			pendingWrites.current.deleted.add(subscription.id);
			setSubscriptions((current) => current?.filter((item) => item.id !== subscription.id) ?? null);
			onChanged?.();
		} catch {
			toast.error(t("calendar.feeds.deleteFailed"));
		} finally {
			writesInFlight.current -= 1;
			setPendingId(null);
		}
	}

	return (
		<>
			{!denied && <FeedsAddForm onAdd={add} />}
			<div className="mt-5 border-t border-neutral-200 pt-4">
				<FeedsList subscriptions={subscriptions} loadError={loadError} denied={denied} editingId={editingId} pendingId={pendingId}
					onRetry={() => { setLoadError(false); setDenied(false); setSubscriptions((current) => current?.length ? current : null); setReloadKey((key) => key + 1); }}
					onEdit={setEditingId} onCancelEdit={() => setEditingId(null)} onSave={save} onDelete={(subscription) => void remove(subscription)} />
			</div>
		</>
	);
}
