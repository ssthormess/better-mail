import { authFetch } from "@/lib/auth/client";
import { isExternalAccountHost, MAX_IDENTITY_LENGTH } from "@/lib/external-accounts/host";
import { normalizeHostname } from "@/lib/domains/utils";
import { requestError } from "@/lib/http/client-error";
import type { ExternalAccountProtocol, ExternalAccountTlsMode, ExternalAccountView } from "@/lib/external-accounts/types";
import type { MailboxDetail } from "./types";

export type ExternalAccountDraft = {
	protocol: ExternalAccountProtocol;
	host: string;
	port: number;
	tlsMode: ExternalAccountTlsMode;
	username: string;
	password: string;
};

/** PATCH accepts any subset; `password` stays absent unless a new one is being set (absent = keep). */
export type ExternalAccountUpdate = Partial<Omit<ExternalAccountDraft, "password">> & { password?: string; enabled?: boolean };

/**
 * The accounts API is gated by `getMailboxAccessLevel`, which admits exactly the owner and full_access
 * delegates — `permission === "full_access"` on the mailbox view is the same set. Read-only delegates and
 * entitled account-admins (permission null) see no card, so they never reach the 403/404 the API would give.
 */
export function canManageExternalAccounts(mailbox: Pick<MailboxDetail, "permission"> | null | undefined): boolean {
	return mailbox?.permission === "full_access";
}

/** The dial port a protocol/TLS-mode pair implies; the form re-seeds on change and stays editable. */
export function defaultExternalAccountPort(protocol: ExternalAccountProtocol, tlsMode: ExternalAccountTlsMode): number {
	if (protocol === "pop3") return tlsMode === "implicit-tls" ? 995 : 110;
	return tlsMode === "implicit-tls" ? 993 : 143;
}

export async function fetchExternalAccounts(mailboxId: string): Promise<ExternalAccountView[]> {
	const res = await authFetch(`/api/mailboxes/${mailboxId}/accounts`);
	const json = (await res.json()) as { accounts?: ExternalAccountView[]; error?: string; code?: string };
	if (!res.ok || !json.accounts) throw requestError(json, "Failed to load external accounts");
	return json.accounts;
}

export async function createExternalAccount(mailboxId: string, input: ExternalAccountDraft): Promise<ExternalAccountView> {
	const res = await authFetch(`/api/mailboxes/${mailboxId}/accounts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as { account?: ExternalAccountView; error?: string; code?: string };
	if (!res.ok || !json.account) throw requestError(json, "Failed to add account");
	return json.account;
}

export async function updateExternalAccount(
	mailboxId: string,
	accountId: string,
	input: ExternalAccountUpdate,
): Promise<ExternalAccountView> {
	const res = await authFetch(`/api/mailboxes/${mailboxId}/accounts/${accountId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as { account?: ExternalAccountView; error?: string; code?: string };
	if (!res.ok || !json.account) throw requestError(json, "Failed to update account");
	return json.account;
}

export async function deleteExternalAccount(mailboxId: string, accountId: string): Promise<void> {
	const res = await authFetch(`/api/mailboxes/${mailboxId}/accounts/${accountId}`, { method: "DELETE" });
	const json = (await res.json()) as { error?: string; code?: string };
	if (!res.ok) throw requestError(json, "Failed to remove account");
}

/** Who a row is, for labels and confirmations: `me@example.com on imap.example.com`. */
export function externalAccountLabel(account: Pick<ExternalAccountView, "username" | "host">): string {
	return `${account.username}@${account.host}`;
}

/**
 * `last_error` comes back sanitized but unbounded; the row shows the first slice only. Rendered as text —
 * never as HTML — so a server message cannot carry markup into the page.
 */
export const EXTERNAL_ACCOUNT_ERROR_MAX_LENGTH = 160;

export function truncateAccountError(value: string): string {
	return value.length > EXTERNAL_ACCOUNT_ERROR_MAX_LENGTH ? `${value.slice(0, EXTERNAL_ACCOUNT_ERROR_MAX_LENGTH)}…` : value;
}

const RELATIVE_TIME_STEPS: [limit: number, size: number, unit: Intl.RelativeTimeFormatUnit][] = [
	[60 * 60_000, 60_000, "minute"],
	[48 * 60 * 60_000, 60 * 60_000, "hour"],
	[30 * 24 * 60 * 60_000, 24 * 60 * 60_000, "day"],
];

/** "5 minutes ago" style ages for `last_synced_at`; under a minute the caller's `justNow` label wins. */
export function formatSyncAge(value: string, locale: string | undefined, justNow: string, now = Date.now()): string {
	const age = now - new Date(value).getTime();
	if (!Number.isFinite(age) || age < 60_000) return justNow;
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	for (const [limit, size, unit] of RELATIVE_TIME_STEPS) {
		if (age < limit) return format.format(-Math.floor(age / size), unit);
	}
	return format.format(-Math.floor(age / (30 * 24 * 60 * 60_000)), "month");
}

export type ExternalAccountFormErrors = { host?: boolean; port?: boolean; username?: boolean; password?: boolean };

/** The same pre-flight checks the API runs, so a bad draft never becomes a request. */
export function validateExternalAccountDraft(
	values: { host: string; port: string; username: string; password: string },
	{ passwordRequired }: { passwordRequired: boolean },
): ExternalAccountFormErrors {
	const errors: ExternalAccountFormErrors = {};
	const host = normalizeHostname(values.host);
	if (!host || host.length > MAX_IDENTITY_LENGTH || !isExternalAccountHost(host)) errors.host = true;
	const port = Number(values.port);
	if (!/^\d+$/.test(values.port.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) errors.port = true;
	if (!values.username.trim() || values.username.length > MAX_IDENTITY_LENGTH) errors.username = true;
	if (passwordRequired && !values.password) errors.password = true;
	return errors;
}
