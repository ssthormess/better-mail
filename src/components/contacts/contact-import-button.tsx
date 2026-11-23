"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { importContacts } from "./contacts-page-utils";

/**
 * "Import" button plus its hidden file picker: the chosen .vcf is posted to the
 * import route and the reported counts land in a toast. `onImported` runs when at
 * least one contact was written so the list can refresh.
 */
export function ContactImportButton({ mailboxId, onImported }: { mailboxId: string; onImported: () => void }) {
	const { t } = useLanguage();
	const inputRef = useRef<HTMLInputElement>(null);
	const [importing, setImporting] = useState(false);

	async function onPick(file: File) {
		setImporting(true);
		try {
			const result = await importContacts(mailboxId, file);
			const totals = {
				imported: result.imported,
				updated: result.updated,
				skipped: result.skipped,
				failed: result.failed,
			};
			if (result.imported + result.updated === 0) {
				// The file parsed but nothing was written: show the counts when there
				// were cards to try, or that it simply held no contacts at all.
				toast.error(
					result.skipped + result.failed > 0
						? t("contacts.importSummarySkipped", totals)
						: t("contacts.importEmpty"),
				);
				return;
			}
			toast.success(
				result.skipped + result.failed > 0
					? t("contacts.importSummarySkipped", totals)
					: t("contacts.importSummary", totals),
			);
			onImported();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("contacts.importFailed"));
		} finally {
			setImporting(false);
		}
	}

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				accept=".vcf,text/vcard,text/x-vcard"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					// Clear the pick so choosing the same file again still fires onChange.
					event.target.value = "";
					if (file) void onPick(file);
				}}
			/>
			<Button type="button" variant="outline" disabled={!mailboxId || importing} onClick={() => inputRef.current?.click()}>
				<Upload className="h-4 w-4" />
				{t("contacts.import")}
			</Button>
		</>
	);
}
