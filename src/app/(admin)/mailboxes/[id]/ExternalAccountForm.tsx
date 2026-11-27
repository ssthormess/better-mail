"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { ExternalAccountProtocol, ExternalAccountTlsMode, ExternalAccountView } from "@/lib/external-accounts/types";
import {
	defaultExternalAccountPort,
	validateExternalAccountDraft,
	type ExternalAccountDraft,
	type ExternalAccountFormErrors,
	type ExternalAccountUpdate,
} from "./external-accounts-utils";

export type ExternalAccountFormProps = {
	/** Set for the edit dialog; absent the form creates. */
	account?: ExternalAccountView;
	pending: boolean;
	/** The API failure to show under the fields, if the last submit returned one. */
	submitError?: string | null;
	onSubmit: (input: ExternalAccountDraft | ExternalAccountUpdate) => void;
};

const selectContainer = "flex w-full rounded-none border-0 p-0";
const selectField = "h-10 rounded-md border border-neutral-200 bg-white px-3 text-sm shadow-sm shadow-neutral-200/50 focus-visible:border-blue-600";

/**
 * The add/edit fields. A password box never shows the stored password (the API returns `passwordSet`, never a
 * value): on edit it starts empty and only an entered value is sent, which is also what re-encrypts.
 */
export function ExternalAccountForm({ account, pending, submitError, onSubmit }: ExternalAccountFormProps) {
	const { t } = useLanguage();
	const [protocol, setProtocol] = useState<ExternalAccountProtocol>(account?.protocol ?? "imap");
	const [tlsMode, setTlsMode] = useState<ExternalAccountTlsMode>(account?.tlsMode ?? "implicit-tls");
	const [host, setHost] = useState(account?.host ?? "");
	const [port, setPort] = useState(account ? String(account.port) : String(defaultExternalAccountPort("imap", "implicit-tls")));
	const [username, setUsername] = useState(account?.username ?? "");
	const [password, setPassword] = useState("");
	const [errors, setErrors] = useState<ExternalAccountFormErrors>({});

	function applyProtocol(next: ExternalAccountProtocol) {
		setProtocol(next);
		setPort(String(defaultExternalAccountPort(next, tlsMode)));
	}
	function applyTlsMode(next: ExternalAccountTlsMode) {
		setTlsMode(next);
		setPort(String(defaultExternalAccountPort(protocol, next)));
	}

	function submit() {
		const fieldErrors = validateExternalAccountDraft({ host, port, username, password }, { passwordRequired: !account });
		setErrors(fieldErrors);
		if (Object.keys(fieldErrors).length > 0) return;
		const base = { protocol, host: host.trim(), port: Number(port.trim()), tlsMode, username: username.trim() };
		// An untouched password box means "keep the stored one": the key is not sent at all.
		onSubmit(account ? { ...base, ...(password ? { password } : {}) } : { ...base, password });
	}

	return (
		<div className="space-y-4">
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-2">
					<Label htmlFor="external-protocol">{t("mailbox.external.protocol")}</Label>
					<Select
						id="external-protocol"
						value={protocol}
						onChange={(event) => applyProtocol(event.target.value as ExternalAccountProtocol)}
						disabled={pending}
						containerClassName={selectContainer}
						className={selectField}
					>
						<option value="imap">IMAP</option>
						<option value="pop3">POP3</option>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="external-tls">{t("mailbox.external.tlsMode")}</Label>
					<Select
						id="external-tls"
						value={tlsMode}
						onChange={(event) => applyTlsMode(event.target.value as ExternalAccountTlsMode)}
						disabled={pending}
						containerClassName={selectContainer}
						className={selectField}
					>
						<option value="implicit-tls">TLS</option>
						<option value="starttls">STARTTLS</option>
						<option value="none">{t("common.none")}</option>
					</Select>
				</div>
			</div>
			<div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
				<div className="space-y-2">
					<Label htmlFor="external-host">{t("mailbox.external.host")}</Label>
					<Input
						id="external-host"
						value={host}
						onChange={(event) => setHost(event.target.value)}
						placeholder={t("mailbox.external.hostPlaceholder")}
						disabled={pending}
						aria-invalid={errors.host || undefined}
					/>
					{errors.host && <p className="text-xs text-red-600">{t("mailbox.external.invalidHost")}</p>}
				</div>
				<div className="space-y-2">
					<Label htmlFor="external-port">{t("mailbox.external.port")}</Label>
					<Input
						id="external-port"
						value={port}
						onChange={(event) => setPort(event.target.value)}
						inputMode="numeric"
						disabled={pending}
						aria-invalid={errors.port || undefined}
					/>
					{errors.port && <p className="text-xs text-red-600">{t("mailbox.external.invalidPort")}</p>}
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="external-username">{t("mailbox.external.username")}</Label>
				<Input
					id="external-username"
					value={username}
					onChange={(event) => setUsername(event.target.value)}
					autoComplete="off"
					disabled={pending}
					aria-invalid={errors.username || undefined}
				/>
				{errors.username && <p className="text-xs text-red-600">{t("mailbox.external.usernameRequired")}</p>}
			</div>
			<div className="space-y-2">
				<Label htmlFor="external-password">{t("common.password")}</Label>
				<Input
					id="external-password"
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					placeholder={account ? t("mailbox.external.passwordKeep") : t("mailbox.external.passwordPlaceholder")}
					autoComplete="new-password"
					disabled={pending}
					aria-invalid={errors.password || undefined}
				/>
				{errors.password && <p className="text-xs text-red-600">{t("mailbox.external.passwordRequired")}</p>}
			</div>
			{submitError && (
				<p role="alert" className="text-sm text-red-600">{submitError}</p>
			)}
			<Button onClick={submit} disabled={pending}>
				{pending ? t("common.saving") : account ? t("settings.mailbox.saveChanges") : t("mailbox.external.add")}
			</Button>
		</div>
	);
}
