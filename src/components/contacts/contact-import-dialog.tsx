"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ContactImportConflict, ContactImportDialogProps, ContactImportPreview } from "./contacts-page-types";
import { importContacts, previewContactImport, reportImportResult } from "./contacts-page-utils";

/**
 * CSV import step two: the picked file is previewed against the address book
 * (nothing is written yet), the user picks what existing contacts do, and
 * confirming posts the same file again with that policy.
 */
export function ContactImportDialog({ mailboxId, file, onOpenChange, onImported }: ContactImportDialogProps) {
	const { t } = useLanguage();
	return (
		<Dialog open={file !== null} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("contacts.importTitle")}</DialogTitle>
					<DialogDescription>{t("contacts.importDescription", { file: file?.name ?? "" })}</DialogDescription>
				</DialogHeader>
				{file && (
					<CsvImportConfirm
						mailboxId={mailboxId}
						file={file}
						onOpenChange={onOpenChange}
						onImported={onImported}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Lives inside DialogContent so it unmounts with the dialog and every open starts clean. */
function CsvImportConfirm({
	mailboxId,
	file,
	onOpenChange,
	onImported,
}: {
	mailboxId: string;
	file: File;
	onOpenChange: ContactImportDialogProps["onOpenChange"];
	onImported: ContactImportDialogProps["onImported"];
}) {
	const { t } = useLanguage();
	const [loading, setLoading] = useState(true);
	const [preview, setPreview] = useState<ContactImportPreview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<ContactImportConflict>("update");
	const [importing, setImporting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		previewContactImport(mailboxId, file)
			.then((result) => {
				if (cancelled) return;
				setPreview(result);
				setLoading(false);
			})
			.catch((previewError) => {
				if (cancelled) return;
				setError(previewError instanceof Error ? previewError.message : t("contacts.importFailed"));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [mailboxId, file, t]);

	async function confirm() {
		setImporting(true);
		setError(null);
		try {
			const result = await importContacts(mailboxId, file, { format: "csv", conflict });
			if (reportImportResult(t, result)) onImported();
			onOpenChange(false);
		} catch (importError) {
			setError(importError instanceof Error ? importError.message : t("contacts.importFailed"));
		} finally {
			setImporting(false);
		}
	}

	if (loading) {
		return <p className="text-sm text-neutral-500">{t("common.loading")}</p>;
	}

	if (!preview) {
		return (
			<>
				{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
				<div className="flex justify-end gap-2 border-t border-neutral-200 pt-4">
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
				</div>
			</>
		);
	}

	const writable = preview.counts.new + preview.counts.existing + preview.counts.unknown;
	return (
		<>
			<p className="text-sm text-neutral-700">
				{t("contacts.importCounts", {
					new: preview.counts.new,
					existing: preview.counts.existing,
					invalid: preview.counts.invalid,
					duplicates: preview.counts.duplicates,
				})}
			</p>
			{preview.counts.unknown > 0 && (
				<p className="text-sm text-neutral-500">{t("contacts.importUnverified", { unknown: preview.counts.unknown })}</p>
			)}
			{preview.counts.skipped > 0 && (
				<p className="text-sm text-neutral-500">{t("contacts.importOverLimit", { skipped: preview.counts.skipped })}</p>
			)}
			{preview.counts.existing + preview.counts.unknown > 0 && (
				<div role="radiogroup" aria-label={t("contacts.importPolicyLabel")} className="space-y-2">
					{(["update", "skip"] as const).map((policy) => (
						<label key={policy} className="flex cursor-pointer items-center gap-3 rounded-xl bg-neutral-50 p-4">
							<input
								type="radio"
								name="contact-import-conflict"
								checked={conflict === policy}
								disabled={importing}
								onChange={() => setConflict(policy)}
							/>
							<span className="flex-1 text-sm font-medium text-neutral-900">
								{policy === "update" ? t("contacts.importPolicyUpdate") : t("contacts.importPolicySkip")}
							</span>
						</label>
					))}
				</div>
			)}
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
			<div className="flex justify-end gap-2 border-t border-neutral-200 pt-4">
				<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
					{t("common.cancel")}
				</Button>
				<Button type="button" onClick={() => void confirm()} disabled={importing || writable === 0}>
					{importing ? t("contacts.importing") : t("contacts.import")}
				</Button>
			</div>
		</>
	);
}
