"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Pencil, Plus, Server, Trash2 } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { ExternalAccountForm } from "./ExternalAccountForm";
import {
	createExternalAccount,
	deleteExternalAccount,
	externalAccountLabel,
	fetchExternalAccounts,
	formatSyncAge,
	truncateAccountError,
	updateExternalAccount,
	type ExternalAccountDraft,
	type ExternalAccountUpdate,
} from "./external-accounts-utils";

/**
 * The "External accounts" section of mailbox settings. Rendered only for owners and full_access delegates —
 * the accounts API returns 403 to anyone below that, so the page mounts this card only when
 * `canManageExternalAccounts` says the mailbox view's permission is `full_access`.
 */
export function ExternalAccountsCard({ mailboxId }: { mailboxId: string }) {
	const { t, locale } = useLanguage();
	const qc = useQueryClient();
	const [addOpen, setAddOpen] = useState(false);
	const [editing, setEditing] = useState<ExternalAccountView | null>(null);

	const accounts = useQuery({
		queryKey: ["mailbox", mailboxId, "external-accounts"],
		queryFn: () => fetchExternalAccounts(mailboxId),
	});

	const refresh = () => qc.invalidateQueries({ queryKey: ["mailbox", mailboxId, "external-accounts"] });

	const create = useMutation({
		mutationFn: (input: ExternalAccountDraft) => createExternalAccount(mailboxId, input),
		onSuccess: () => {
			setAddOpen(false);
			void refresh();
		},
	});
	const update = useMutation({
		mutationFn: ({ accountId, input }: { accountId: string; input: ExternalAccountUpdate }) =>
			updateExternalAccount(mailboxId, accountId, input),
		onSuccess: () => {
			setEditing(null);
			void refresh();
		},
	});
	const remove = useMutation({
		mutationFn: (accountId: string) => deleteExternalAccount(mailboxId, accountId),
		onSuccess: () => void refresh(),
	});

	const pending = create.isPending || update.isPending;

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0">
				<CardTitle>{t("mailbox.external.title")}</CardTitle>
				<CardDescription>{t("mailbox.external.description")}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 pt-5">
				{accounts.isLoading && <Skeleton className="h-12 w-full rounded-2xl" />}
				{(accounts.data ?? []).map((account) => {
					const label = externalAccountLabel(account);
					const skipped = account.skippedUids.length + account.skippedUidls.length;
					return (
						<div
							key={account.id}
							className="flex items-center justify-between gap-3 rounded-2xl bg-neutral-50 px-4 py-3"
						>
							<div className="flex min-w-0 items-center gap-3">
								<Server className="h-4 w-4 shrink-0 text-neutral-400" />
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<p className="truncate no-font-mono text-sm font-medium text-neutral-900">
											{account.host}:{account.port}
										</p>
										<Badge variant="secondary">{account.protocol.toUpperCase()}</Badge>
									</div>
									<p className="truncate text-xs text-neutral-500">{account.username}</p>
									<p className="mt-0.5 text-xs text-neutral-500">
										{account.lastSyncedAt
											? t("mailbox.external.lastSync", { age: formatSyncAge(account.lastSyncedAt, locale, t("mailbox.external.justNow")) })
											: t("mailbox.external.neverSynced")}
									</p>
									{account.lastError && (
										<p className="mt-0.5 break-words text-xs text-amber-700" title={account.lastError}>
											{truncateAccountError(account.lastError)}
										</p>
									)}
									{skipped > 0 && (
										<p className="mt-0.5 text-xs text-amber-700">
											{t("mailbox.external.skipped", { count: skipped })}
										</p>
									)}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Switch
									checked={account.enabled}
									disabled={update.isPending}
									aria-label={t(account.enabled ? "mailbox.external.disableAccount" : "mailbox.external.enableAccount", { account: label })}
									onCheckedChange={(enabled) => update.mutate({ accountId: account.id, input: { enabled } })}
								/>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									aria-label={t("mailbox.external.editAccount", { account: label })}
									onClick={() => setEditing(account)}
								>
									<Pencil className="h-4 w-4" />
								</Button>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									aria-label={t("mailbox.external.removeAccount", { account: label })}
									disabled={remove.isPending}
									onClick={async () => {
										if (!await confirmDestructive(t("mailbox.external.removeConfirm", { account: label }))) return;
										remove.mutate(account.id);
									}}
								>
									<Trash2 className="h-4 w-4 text-red-600" />
								</Button>
							</div>
						</div>
					);
				})}
				{accounts.data && accounts.data.length === 0 && (
					<p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
						{t("mailbox.external.empty")}
					</p>
				)}
				{accounts.isError && (
					<p className="text-sm text-red-600">
						{accounts.error instanceof Error ? accounts.error.message : t("mailbox.external.loadFailed")}
					</p>
				)}
				{update.isError && (
					<p className="text-sm text-red-600">
						{update.error instanceof Error ? update.error.message : t("mailbox.external.updateFailed")}
					</p>
				)}
				{remove.isError && (
					<p className="text-sm text-red-600">
						{remove.error instanceof Error ? remove.error.message : t("mailbox.external.removeFailed")}
					</p>
				)}
				<div>
					<Button type="button" onClick={() => setAddOpen(true)}>
						<Plus className="h-4 w-4" />
						{t("mailbox.external.add")}
					</Button>
				</div>
			</CardContent>
			<Dialog open={addOpen} onOpenChange={setAddOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("mailbox.external.addTitle")}</DialogTitle>
						<DialogDescription>{t("mailbox.external.addDescription")}</DialogDescription>
					</DialogHeader>
					<ExternalAccountForm
						pending={pending}
						submitError={create.isError ? (create.error instanceof Error ? create.error.message : t("mailbox.external.addFailed")) : null}
						onSubmit={(input) => create.mutate(input as ExternalAccountDraft)}
					/>
				</DialogContent>
			</Dialog>
			<Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("mailbox.external.editTitle")}</DialogTitle>
						<DialogDescription>{t("mailbox.external.editDescription")}</DialogDescription>
					</DialogHeader>
					{editing && (
						<ExternalAccountForm
							key={editing.id}
							account={editing}
							pending={pending}
							submitError={update.isError ? (update.error instanceof Error ? update.error.message : t("mailbox.external.updateFailed")) : null}
							onSubmit={(input) => update.mutate({ accountId: editing.id, input: input as ExternalAccountUpdate })}
						/>
					)}
				</DialogContent>
			</Dialog>
		</Card>
	);
}
