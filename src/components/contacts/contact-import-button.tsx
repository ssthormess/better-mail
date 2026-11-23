"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { ContactImportDialog } from "./contact-import-dialog";
import { importContacts, reportImportResult } from "./contacts-page-utils";

/**
 * "Import" button plus its hidden file picker. A .vcf posts straight to the
 * import route and the counts land in a toast; a .csv opens the two-step dialog
 * (preview and a conflict policy) before anything is written. `onImported` runs
 * when at least one contact was written so the list can refresh.
 */
export function ContactImportButton({ mailboxId, onImported }: { mailboxId: string; onImported: () => void }) {
	const { t } = useLanguage();
	const inputRef = useRef<HTMLInputElement>(null);
	const [importing, setImporting] = useState(false);
	const [csvFile, setCsvFile] = useState<File | null>(null);

	async function onPick(file: File) {
		if (/\.csv$/i.test(file.name)) {
			setCsvFile(file);
			return;
		}
		setImporting(true);
		try {
			const result = await importContacts(mailboxId, file);
			if (reportImportResult(t, result)) onImported();
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
				accept=".vcf,.csv,text/vcard,text/x-vcard,text/csv"
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
			<ContactImportDialog
				mailboxId={mailboxId}
				file={csvFile}
				onOpenChange={(open) => {
					if (!open) setCsvFile(null);
				}}
				onImported={onImported}
			/>
		</>
	);
}
