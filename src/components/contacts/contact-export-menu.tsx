"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { useLanguage } from "@/components/language-provider";

const ITEM_CLASS = "flex cursor-pointer items-center rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100";

/**
 * Pick the export format for the address book. `trigger` must be a single
 * focusable element; `onPick` receives "vcf" or "csv".
 */
export function ContactExportMenu({ trigger, disabled, onPick }: {
	trigger: ReactNode;
	disabled?: boolean;
	onPick: (format: "vcf" | "csv") => void;
}) {
	const { t } = useLanguage();
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild disabled={disabled}>{trigger}</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg">
					<DropdownMenu.Item onSelect={() => onPick("vcf")} className={ITEM_CLASS}>
						{t("contacts.exportVcard")}
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => onPick("csv")} className={ITEM_CLASS}>
						{t("contacts.exportCsv")}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
