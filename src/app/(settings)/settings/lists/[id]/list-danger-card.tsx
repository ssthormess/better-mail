"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import type { MailingList } from "../types";
import { deleteMailingList, refetchMailingListIndex, removeMailingListFromIndex } from "../utils";

export function ListDangerCard({ list }: { list: MailingList }) {
	const { t } = useLanguage();
	const qc = useQueryClient();
	const router = useRouter();

	const remove = useMutation({
		mutationFn: () => deleteMailingList(list.id),
		onSuccess: async () => {
			removeMailingListFromIndex(qc, list.id);
			// Drop the detail snapshot too — a cached URL must not resurrect dead controls.
			qc.removeQueries({ queryKey: ["mailing-list", list.id] });
			await refetchMailingListIndex(qc);
			router.push("/settings/lists");
		},
	});

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle className="text-red-700">{t("mailbox.dangerZone")}</CardTitle>
				<CardDescription>{t("mailingLists.dangerDescription", { address: list.address })}</CardDescription>
			</CardHeader>
			<CardContent className="pt-5">
				{remove.isError && (
					<p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
						{remove.error instanceof Error ? remove.error.message : t("mailingLists.deleteFailed")}
					</p>
				)}
				<Button
					type="button"
					variant="destructive"
					disabled={remove.isPending}
					onClick={async () => {
						if (!await confirmDestructive(t("mailingLists.deleteConfirm", { address: list.address }))) return;
						remove.mutate();
					}}
				>
					<Trash2 className="h-4 w-4" />
					{remove.isPending ? t("mailbox.deleting") : t("mailingLists.delete")}
				</Button>
			</CardContent>
		</Card>
	);
}
