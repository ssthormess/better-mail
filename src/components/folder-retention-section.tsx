"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "./language-provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MAX_TRASH_RETENTION_DAYS, MIN_TRASH_RETENTION_DAYS } from "@/lib/email/trash-retention-utils";
import {
	DEFAULT_FOLDER_RETENTION_DAYS,
	folderRetentionDraft,
	getFolderRetention,
	type FolderRetentionDraft,
} from "./folder-retention-utils";

type Props = {
	folderId: string;
	/** The same manage right the folder edit itself uses (`selectedMailbox.permission`). */
	canManage: boolean;
	/** The dialog is saving; freeze the control. */
	disabled?: boolean;
	/** Reports the draft after the rule loads and on every edit; the host form saves it on Save. */
	onChange?: (draft: FolderRetentionDraft) => void;
};

/**
 * The per-folder retention rule inside the folder dialog: a switch for "auto-delete old mail" plus a
 * days input bound to the API's 1-365 range. Reading the rule only needs folder access, so a delegate
 * sees the effective state with the controls disabled; writing needs the manage right and rides the
 * dialog's Save through `onChange`.
 */
export function FolderRetentionSection({ folderId, canManage, disabled, onChange }: Props) {
	const { t } = useLanguage();
	const [baseline, setBaseline] = useState<number | null>(null);
	const [enabled, setEnabled] = useState(false);
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	// The latest callback, so the load effect and edits report to the current parent without
	// re-running the fetch when the parent's handler identity changes.
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});

	useEffect(() => {
		let cancelled = false;
		getFolderRetention(folderId)
			.then((days) => {
				if (cancelled) return;
				setBaseline(days);
				setEnabled(days !== null);
				setInput(days === null ? "" : String(days));
				setStatus("ready");
				onChangeRef.current?.({ days, baseline: days, valid: true });
			})
			.catch(() => {
				if (!cancelled) setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [folderId]);

	function report(nextEnabled: boolean, nextInput: string) {
		onChangeRef.current?.(folderRetentionDraft(nextEnabled, nextInput, baseline));
	}

	function toggle(next: boolean) {
		const nextInput = next && !input ? String(DEFAULT_FOLDER_RETENTION_DAYS) : input;
		setEnabled(next);
		setInput(nextInput);
		report(next, nextInput);
	}

	const draft = folderRetentionDraft(enabled, input, baseline);
	const frozen = !canManage || disabled || status === "loading";

	return (
		<div className="space-y-2">
			<Label>{t("navigation.folderRetention")}</Label>
			{status === "error" ? (
				<p role="alert" className="text-sm text-red-600">{t("navigation.folderRetentionLoadFailed")}</p>
			) : (
				<div className="space-y-3 rounded-xl bg-neutral-50 p-4">
					<label className="flex items-center gap-3">
						<Switch
							checked={enabled}
							disabled={frozen}
							onCheckedChange={toggle}
							aria-label={t("navigation.folderRetentionToggle")}
						/>
						<span className="text-sm font-medium text-neutral-900">{t("navigation.folderRetentionToggle")}</span>
					</label>
					{enabled && (
						<label className="flex items-center gap-2">
							<span className="text-sm text-neutral-700">{t("navigation.folderRetentionDeleteAfter")}</span>
							<Input
								type="number"
								min={MIN_TRASH_RETENTION_DAYS}
								max={MAX_TRASH_RETENTION_DAYS}
								step={1}
								inputMode="numeric"
								value={input}
								disabled={frozen}
								onChange={(event) => {
									setInput(event.target.value);
									report(enabled, event.target.value);
								}}
								className="w-24"
							/>
							<span className="text-sm text-neutral-700">{t("navigation.folderRetentionDays")}</span>
						</label>
					)}
					{!draft.valid && (
						<p role="alert" className="text-xs text-red-600">{t("navigation.folderRetentionInvalid")}</p>
					)}
					<p className="text-xs text-neutral-500">
						{enabled ? t("navigation.folderRetentionRuleHelp") : t("navigation.folderRetentionInheritHelp")}
					</p>
					{!canManage && (
						<p className="text-xs text-neutral-500">{t("navigation.folderRetentionNeedAccess")}</p>
					)}
				</div>
			)}
		</div>
	);
}
