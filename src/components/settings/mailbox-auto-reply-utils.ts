import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { formatUserDate, formatUserDateTimeLocal, parseUserDateTimeLocal } from "@/lib/time/utils";
import type { MailboxAutoReplySettings } from "./types";

const WINDOW_DATE_FORMAT: Intl.DateTimeFormatOptions = {
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
};

/** The window as the API stores it: UTC ISO strings or null for open-ended. */
export function autoReplyWindowToIso(settings: Pick<MailboxAutoReplySettings, "startAt" | "endAt">): { autoReplyStartAt: string | null; autoReplyEndAt: string | null } {
	return {
		autoReplyStartAt: settings.startAt ? parseUserDateTimeLocal(settings.startAt)?.toISOString() ?? null : null,
		autoReplyEndAt: settings.endAt ? parseUserDateTimeLocal(settings.endAt)?.toISOString() ?? null : null,
	};
}

/** The window as the form holds it: `datetime-local` wall times, "" when unset. */
export function autoReplyWindowFromIso(autoReplyStartAt: string | Date | null | undefined, autoReplyEndAt: string | Date | null | undefined): Pick<MailboxAutoReplySettings, "startAt" | "endAt"> {
	return {
		startAt: autoReplyStartAt ? formatUserDateTimeLocal(new Date(autoReplyStartAt)) : "",
		endAt: autoReplyEndAt ? formatUserDateTimeLocal(new Date(autoReplyEndAt)) : "",
	};
}

export function parseAutoReplyWindow(settings: Pick<MailboxAutoReplySettings, "startAt" | "endAt">): { start: Date | null; end: Date | null } {
	return {
		start: settings.startAt ? parseUserDateTimeLocal(settings.startAt) : null,
		end: settings.endAt ? parseUserDateTimeLocal(settings.endAt) : null,
	};
}

/** One line describing where the responder stands: off, scheduled, active or expired. */
export function describeAutoReplyWindow(
	settings: Pick<MailboxAutoReplySettings, "enabled" | "startAt" | "endAt">,
	t: Translator = defaultTranslator,
	now = new Date(),
): string {
	if (!settings.enabled) return t("settings.autoReply.state.off");
	const { start, end } = parseAutoReplyWindow(settings);
	if (end && now > end) return t("settings.autoReply.state.expired", { end: formatUserDate(end, WINDOW_DATE_FORMAT) });
	if (start && now < start) {
		return end
			? t("settings.autoReply.state.scheduledRange", { start: formatUserDate(start, WINDOW_DATE_FORMAT), end: formatUserDate(end, WINDOW_DATE_FORMAT) })
			: t("settings.autoReply.state.scheduled", { start: formatUserDate(start, WINDOW_DATE_FORMAT) });
	}
	return end
		? t("settings.autoReply.state.activeUntil", { end: formatUserDate(end, WINDOW_DATE_FORMAT) })
		: t("settings.autoReply.state.active");
}
