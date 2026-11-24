import ICAL from "ical.js";
import { isIcsAddress } from "./ics";
import { isSeriesOccurrence, occurrenceStart } from "./tool-occurrences";
import { normalizeCalendarColor } from "./colors";
import { MAX_REMINDER_MINUTES, normalizeReminderMinutes } from "./reminder-utils";
import { normalizeCalendarRepeatDays, parseCalendarRepeatDays } from "./recurrence";
import { dateFromZonedFields, isValidTimeZone, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";

/**
 * Parses an .ics (RFC 5545) upload into `calendar_events` + `calendar_event_overrides` rows — the
 * inverse of buildCalendarFeed. Importing creates USER events: the invitation columns (responseStatus,
 * inviteMessageId, inviteSender, inviteSequence, eventSequence, attendeeResponses) stay at their
 * defaults, and no invitations are sent.
 *
 * Deliberate mapping decisions (documented for the caller and surfaced in `errors`):
 * - Dedup: there is no uid column, so identity comes from the file UID — `evt_i_<sha256>` of
 *   (userId, "uid", UID), and a detached occurrence imported without its master keys on
 *   (userId, UID, RECURRENCE-ID instant). A revised file lands on the same row and the route
 *   upserts: master fields update from the file, overrides insert or update per
 *   (eventId, occurrenceMs), and local-only overrides are left alone. Events with no UID fall
 *   back to a content hash of every stored field: an identical re-import is still skipped, while
 *   a changed one coexists as a second event — with no stable identity there is nothing to update.
 *   Override ids hash only (userId, eventId, occurrenceMs), the table's natural key.
 * - TZID resolution prefers Intl (the expander's own tz source). An Intl-unknown TZID resolves
 *   through the file's VTIMEZONE for the stored instants, but no IANA name exists to store, so the
 *   series recurs in UTC — noted per event. A TZID neither knows resolves as floating.
 * - Floating times (no TZID, no Z) take the request/user zone passed as `floatingZone` and keep it
 *   as the event's timeZone, so the series follows that zone's DST like the user expects.
 * - VALUE=DATE (all-day) becomes midnight-to-midnight in the resolved zone; the app has no all-day
 *   flag. A zero-duration DATE-TIME (no DTEND/DURATION) stores endsAt == startsAt per RFC.
 * - RRULE maps onto the app repeat model; COUNT becomes a repeatUntil bound by walking the app's
 *   own occurrence rule (capped, then left open-ended with a note). A rule the model cannot express
 *   (INTERVAL>1 with weekday lists, nth-weekday yearly, BYWEEKNO, …) degrades the event to a single
 *   occurrence with a note rather than silently importing a different series.
 * - DTSTART is always an instance in RFC 5545; when the mapped rule would not produce it (a foreign
 *   BYDAY that excludes DTSTART's weekday) an extra-occurrence override restores it.
 * - RECURRENCE-ID VEVENTs become overrides keyed by the resolved instant; STATUS:CANCELLED ones add
 *   an exclusion instead. RDATEs become overrides at non-rule instants (extras). RANGE=THISANDFUTURE,
 *   ORGANIZER, SEQUENCE and ATTENDEE parameters (PARTSTAT/CN/ROLE) have no app equivalent and are
 *   dropped with a note where the loss is material.
 * - VALARM: the first DISPLAY alarm with a before-start trigger maps to reminderMinutes
 *   (<= MAX_REMINDER_MINUTES); EMAIL/AUDIO actions, RELATED=END and after-start triggers are noted
 *   and skipped. STATUS:TENTATIVE is noted and dropped — responseStatus is invite-pipeline state.
 */

/** Largest upload the synchronous import accepts, bytes of the whole request body. */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
/** Largest event count one import writes. */
export const MAX_IMPORT_EVENTS = 2000;
/** Rule steps tried while bounding a COUNT; past it the series stays open-ended (a COUNT this large is a lifetime anyway). */
const MAX_COUNT_CANDIDATES = 20000;
/** Notes returned to the caller; past this they are counted and summarized. */
const MAX_IMPORT_ERRORS = 100;
const MAX_ATTENDEES = 200;

/** The body was not iCalendar at all -> HTTP 400. */
export class IcsParseError extends Error {}
/** The file exceeds an import bound -> HTTP 413. */
export class IcsLimitError extends Error {}

export type ImportEventRow = {
	id: string;
	userId: string;
	mailboxId: string | null;
	title: string;
	description: string;
	location: string;
	attendees: string;
	color: string;
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "yearly";
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	repeatInterval: number;
	repeatWeekday: number | null;
	repeatWeek: number | null;
	excludedOccurrences: string;
	timeZone: string | null;
	startsAt: Date;
	endsAt: Date;
	reminderMinutes: number | null;
};

export type ImportOverrideRow = {
	id: string;
	eventId: string;
	occurrenceMs: number;
	startsAt: Date;
	endsAt: Date;
	title: string | null;
	description: string | null;
	location: string | null;
};

export type PreparedCalendarImport = {
	events: ImportEventRow[];
	overrides: ImportOverrideRow[];
	/** X-WR-CALNAME of the (first) VCALENDAR, the feed title a subscription can adopt. */
	calendarName: string | null;
	/** VEVENT groups that produced no event (unsupported, cancelled or invalid). */
	skipped: number;
	errors: string[];
};

/**
 * Identity for the rows a parse creates. File imports key events by (userId, UID) into the evt_i_
 * namespace; subscriptions fold the feed id into the hash and use evt_s_, so the same UID in
 * another feed — or in a feed and a file import — never shares a row, and a refresh can prune
 * feed-owned events without ever touching user, imported or invited rows.
 */
export type ImportIdScheme = {
	/** Prefix stamped on every generated row id. */
	prefix: string;
	/** Hash input for a seeded event (seed = the file UID, or UID#RECURRENCE-ID for an orphan). */
	seedMaterial: (seed: string) => string;
	/** Hash input for a seedless event; material serializes every stored field. */
	fieldsMaterial: (material: string) => string;
	/** Hash input for an override's natural key (eventId + occurrenceMs). */
	overrideMaterial: (eventId: string, occurrenceMs: number) => string;
};

/** The file-import scheme: evt_i_ rows keyed on the user and the file's UID alone. */
export function importIdScheme(userId: string): ImportIdScheme {
	return {
		prefix: "evt_i",
		seedMaterial: (seed) => `${userId}uid:${seed}`,
		fieldsMaterial: (material) => `${userId}fields:${material}`,
		overrideMaterial: (eventId, occurrenceMs) => `${userId}${eventId}${occurrenceMs}`,
	};
}

type RepeatKind = ImportEventRow["repeat"];
type RecurrenceProbe = Parameters<typeof occurrenceStart>[0];

const WEEKDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const BYDAY_PATTERN = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/;

async function sha256Hex(material: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ZoneContext = {
	/** Zone floating times resolve in, normalized. */
	floatingZone: string;
	/** TZID -> the file's own VTIMEZONE, for zones Intl does not know. */
	vtimezones: Map<string, ICAL.Timezone>;
	note: (message: string) => void;
};

function tzidOf(property: ICAL.Property | null): string | undefined {
	const value = property?.getParameter("tzid");
	return typeof value === "string" && value ? value : undefined;
}

/** The instant's wall-clock fields as a fake-UTC date, the shape dateFromZonedFields consumes. */
function wallFields(time: ICAL.Time): Date {
	return new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second));
}

/**
 * The instant a parsed DATE-TIME/DATE names, plus the zone worth storing on the event: the Intl
 * name for a TZID ICU knows, the floating zone for floating or unresolvable times, and null for UTC
 * times (exports write Z back out) and for file-only zones (no IANA name can be stored).
 */
function resolveTime(time: ICAL.Time, tzid: string | undefined, ctx: ZoneContext, label: string): { at: Date; timeZone: string | null; fileZoneOnly: boolean } {
	if (time.zone === ICAL.Timezone.utcTimezone) return { at: new Date(time.toUnixTime() * 1000), timeZone: null, fileZoneOnly: false };
	const wall = wallFields(time);
	if (!tzid) return { at: dateFromZonedFields(wall, ctx.floatingZone), timeZone: ctx.floatingZone, fileZoneOnly: false };
	if (isValidTimeZone(tzid)) {
		const zone = normalizeTimeZone(tzid);
		return { at: dateFromZonedFields(wall, zone), timeZone: zone, fileZoneOnly: false };
	}
	const fileZone = ctx.vtimezones.get(tzid);
	if (fileZone) {
		time.zone = fileZone;
		return { at: new Date(time.toUnixTime() * 1000), timeZone: null, fileZoneOnly: true };
	}
	ctx.note(`${label}: unknown TZID "${tzid}" read as ${ctx.floatingZone}`);
	return { at: dateFromZonedFields(wall, ctx.floatingZone), timeZone: ctx.floatingZone, fileZoneOnly: false };
}

type Byday = { ordinal: number | null; dow: number };

function parseByday(value: string): Byday | null {
	const match = BYDAY_PATTERN.exec(value);
	return match ? { ordinal: match[1] === undefined ? null : Number(match[1]), dow: WEEKDAY[match[2]] } : null;
}

type MappedRepeat = {
	repeat: RepeatKind;
	repeatDays: number[];
	repeatAnchorDay: number | null;
	repeatWeekday: number | null;
	repeatWeek: number | null;
	repeatInterval: number;
};

const baseRepeat = (repeat: RepeatKind): MappedRepeat => ({ repeat, repeatDays: [], repeatAnchorDay: null, repeatWeekday: null, repeatWeek: null, repeatInterval: 1 });

/**
 * Maps an RRULE onto the app repeat model for a series starting at `wall` (the resolved start's
 * fields in the expander zone). Returns null when no faithful form exists — the caller degrades to
 * a single occurrence, so nothing silently repeats differently than the file says.
 */
function mapRrule(rule: ICAL.Recur, wall: Date): { map: MappedRepeat | null; reason: string | null } {
	const interval = rule.interval ?? 1;
	const parts = rule.parts ?? {};
	const reject = (reason: string) => ({ map: null, reason });
	if (!Number.isInteger(interval) || interval < 1 || interval > 999) return reject(`INTERVAL=${String(rule.interval)} is not supported`);
	// BY-parts the model cannot express are rejected unless they merely restate DTSTART's fields.
	const bad: string[] = [];
	for (const [key, expected] of [["BYSECOND", wall.getUTCSeconds()], ["BYMINUTE", wall.getUTCMinutes()], ["BYHOUR", wall.getUTCHours()]] as const) {
		const values = parts[key] ?? [];
		if (values.length && !(values.length === 1 && values[0] === expected)) bad.push(key);
	}
	if (parts.BYWEEKNO?.length) bad.push("BYWEEKNO");
	if (parts.BYYEARDAY?.length) bad.push("BYYEARDAY");
	const setpos = parts.BYSETPOS ?? [];
	if (setpos.length > 1 || (setpos.length === 1 && setpos[0] !== -1)) bad.push("BYSETPOS");
	const bydays: Byday[] = [];
	for (const raw of parts.BYDAY ?? []) {
		const parsed = parseByday(raw);
		if (!parsed) { bad.push(`BYDAY=${raw}`); continue; }
		bydays.push(parsed);
	}
	const monthdays = parts.BYMONTHDAY ?? [];
	if (monthdays.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) bad.push("BYMONTHDAY");
	const months = parts.BYMONTH ?? [];
	if (bad.length) return reject(`RRULE parts ${[...new Set(bad)].join(", ")} are not supported`);
	const dows = bydays.map((day) => day.dow);
	const freq = rule.freq;
	if (freq === "DAILY") {
		if (months.length || monthdays.length || setpos.length) return reject("BYMONTH/BYMONTHDAY/BYSETPOS with FREQ=DAILY is not supported");
		if (!bydays.length) return { map: { ...baseRepeat("daily"), repeatInterval: interval }, reason: null };
		// A weekday-filtered daily is the app's listed-days repeat, which steps day by day.
		if (interval !== 1 || bydays.some((day) => day.ordinal !== null)) return reject(`FREQ=DAILY;INTERVAL=${interval};BYDAY is not supported`);
		return { map: { ...baseRepeat("weekdays"), repeatDays: normalizeCalendarRepeatDays(dows) }, reason: null };
	}
	if (freq === "WEEKLY") {
		if (months.length || monthdays.length || setpos.length) return reject("BYMONTH/BYMONTHDAY/BYSETPOS with FREQ=WEEKLY is not supported");
		if (bydays.some((day) => day.ordinal !== null)) return reject("BYDAY ordinals with FREQ=WEEKLY are not supported");
		const anchoredOnly = !dows.length || (dows.length === 1 && dows[0] === wall.getUTCDay());
		if (interval !== 1 && !anchoredOnly) return reject(`FREQ=WEEKLY;INTERVAL=${interval};BYDAY is not supported`);
		if (!bydays.length || anchoredOnly) return { map: { ...baseRepeat("weekly"), repeatInterval: interval }, reason: null };
		return { map: { ...baseRepeat("weekdays"), repeatDays: normalizeCalendarRepeatDays(dows) }, reason: null };
	}
	if (freq === "MONTHLY") {
		if (months.length) return reject("BYMONTH with FREQ=MONTHLY is not supported");
		if (bydays.length) {
			if (monthdays.length || setpos.length || bydays.length > 1) return reject("combined or multiple BYDAY with FREQ=MONTHLY is not supported");
			const { ordinal, dow } = bydays[0];
			if (ordinal === null) return reject("BYDAY without an ordinal with FREQ=MONTHLY is not supported");
			// The app stores a fifth weekday as "last" (they coincide), matching the export's -1 form.
			const week = ordinal === -1 || ordinal === 5 ? -1 : ordinal >= 1 && ordinal <= 4 ? ordinal : null;
			if (week === null) return reject(`BYDAY=${ordinal} week ordinal is not supported`);
			return { map: { ...baseRepeat("monthly"), repeatInterval: interval, repeatWeekday: dow, repeatWeek: week }, reason: null };
		}
		let anchor: number | null = null;
		if (setpos.length === 1) {
			// The export's own clamp encoding (BYMONTHDAY=28..anchor;BYSETPOS=-1): the anchor is the largest day.
			if (!monthdays.length) return reject("BYSETPOS without BYMONTHDAY is not supported");
			anchor = Math.max(...monthdays);
		} else if (monthdays.length > 1) {
			return reject("multiple BYMONTHDAY values are not supported");
		} else if (monthdays.length === 1) {
			anchor = monthdays[0];
		}
		// An anchor equal to the start's day is what a null anchor already means.
		return { map: { ...baseRepeat("monthly"), repeatInterval: interval, repeatAnchorDay: anchor === wall.getUTCDate() ? null : anchor }, reason: null };
	}
	if (freq === "YEARLY") {
		if (bydays.length) return reject("BYDAY with FREQ=YEARLY is not supported");
		if (months.some((month) => month !== wall.getUTCMonth() + 1)) return reject("BYMONTH that changes the yearly month is not supported");
		if (setpos.length === 1) {
			if (!monthdays.length || Math.max(...monthdays) !== wall.getUTCDate()) return reject("BYSETPOS yearly that does not clamp to the start day is not supported");
		} else if (monthdays.some((day) => day !== wall.getUTCDate())) {
			return reject("BYMONTHDAY that changes the yearly day is not supported");
		}
		return { map: { ...baseRepeat("yearly"), repeatInterval: interval }, reason: null };
	}
	return reject(`FREQ=${freq} is not supported`);
}

/**
 * RRULE COUNT is a count of produced occurrences; the app bounds by instant instead. Every rule
 * step produces an occurrence except under a listed-days filter, which the walk must count out.
 */
function countBound(probe: RecurrenceProbe, count: number, expandZone: string, ctx: ZoneContext, label: string): Date | null {
	if (probe.repeat !== "weekdays") return new Date(occurrenceStart(probe, count - 1).getTime() + 1000);
	const days = parseCalendarRepeatDays(probe.repeatDays);
	let seen = 0;
	for (let index = 0; index < MAX_COUNT_CANDIDATES; index++) {
		const at = occurrenceStart(probe, index);
		if (!days.includes(zonedDateFields(at, expandZone).getUTCDay())) continue;
		if (++seen === count) return new Date(at.getTime() + 1000);
	}
	ctx.note(`${label}: COUNT too large to bound exactly; the series is left open-ended`);
	return null;
}

/** UNTIL is inclusive, repeatUntil exclusive — the exact inverse of the export's -1s encoding. */
function untilBound(until: ICAL.Time, expandZone: string): Date {
	if (until.isDate) return dateFromZonedFields(new Date(Date.UTC(until.year, until.month - 1, until.day + 1)), expandZone);
	const at = until.zone === ICAL.Timezone.utcTimezone
		? new Date(until.toUnixTime() * 1000)
		: dateFromZonedFields(wallFields(until), expandZone);
	return new Date(at.getTime() + 1000);
}

function textValue(component: ICAL.Component, name: string): string {
	const value = component.getFirstPropertyValue(name);
	return typeof value === "string" ? value : "";
}

function mapAttendees(vevent: ICAL.Component, label: string, ctx: ZoneContext): string[] {
	const attendees: string[] = [];
	let dropped = 0;
	for (const property of vevent.getAllProperties("attendee")) {
		const value = String(property.getFirstValue() ?? "").replace(/^mailto:/i, "");
		if (isIcsAddress(value) && !attendees.includes(value)) attendees.push(value);
		else dropped += 1;
	}
	if (attendees.length > MAX_ATTENDEES) {
		dropped += attendees.length - MAX_ATTENDEES;
		attendees.length = MAX_ATTENDEES;
	}
	if (dropped) ctx.note(`${label}: ${dropped} attendee value(s) dropped (only mailto: addresses are kept)`);
	return attendees;
}

function mapReminder(vevent: ICAL.Component, startAt: Date, label: string, ctx: ZoneContext): number | null {
	for (const alarm of vevent.getAllSubcomponents("valarm")) {
		const action = String(alarm.getFirstPropertyValue("action") ?? "").toUpperCase();
		if (action !== "DISPLAY") {
			ctx.note(`${label}: VALARM ACTION=${action || "none"} has no app equivalent`);
			continue;
		}
		const triggerProperty = alarm.getFirstProperty("trigger");
		const trigger = triggerProperty?.getFirstValue();
		const related = String(triggerProperty?.getParameter("related") ?? "START").toUpperCase();
		if (related !== "START") {
			ctx.note(`${label}: an alarm relative to the event end is not supported`);
			continue;
		}
		if (trigger instanceof ICAL.Duration) {
			const seconds = trigger.toSeconds();
			if (seconds > 0) {
				ctx.note(`${label}: an alarm after the start is not supported`);
				continue;
			}
			const minutes = normalizeReminderMinutes(Math.round(-seconds / 60));
			if (minutes === null) ctx.note(`${label}: an alarm more than ${MAX_REMINDER_MINUTES} minutes before the start is not supported`);
			else return minutes;
			continue;
		}
		if (trigger instanceof ICAL.Time) {
			// Absolute triggers are UTC by the RFC; minutes-before-start is derived from the master.
			const minutes = Math.round((startAt.getTime() - resolveTime(trigger, undefined, ctx, label).at.getTime()) / 60000);
			const normalized = minutes >= 0 ? normalizeReminderMinutes(minutes) : null;
			if (normalized === null) ctx.note(`${label}: an alarm at a fixed instant is not supported`);
			else ctx.note(`${label}: an alarm at a fixed instant became ${normalized} minutes before the start`);
			if (normalized !== null) return normalized;
			continue;
		}
		ctx.note(`${label}: a VALARM trigger is not supported`);
	}
	return null;
}

type PendingOverride = Omit<ImportOverrideRow, "id" | "eventId">;

type BuiltEvent = {
	row: Omit<ImportEventRow, "id">;
	probe: RecurrenceProbe;
	overrides: Map<number, PendingOverride>;
};

/**
 * Builds the event row and its occurrence overrides (RDATE extras, RECURRENCE-ID exceptions and
 * cancellations) for one UID group. `detached` is merged after the master's own RDATEs so a moved
 * occurrence keeps its detached times and text.
 */
function buildGroup(
	master: ICAL.Component,
	detached: ICAL.Component[],
	extraMasters: ICAL.Component[],
	ctx: ZoneContext,
	label: string,
	note: (message: string) => void,
	allowRrule = true,
): BuiltEvent | null {
	if (String(master.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") {
		note(`${label}: cancelled event, not imported`);
		return null;
	}
	const dtstartProperty = master.getFirstProperty("dtstart");
	const dtstart = dtstartProperty?.getFirstValue();
	if (!(dtstart instanceof ICAL.Time)) {
		note(`${label}: missing DTSTART, skipped`);
		return null;
	}
	const start = resolveTime(dtstart, tzidOf(dtstartProperty), ctx, label);
	let endsAt: Date;
	const dtendProperty = master.getFirstProperty("dtend");
	const dtend = dtendProperty?.getFirstValue();
	const duration = master.getFirstPropertyValue("duration");
	if (dtend instanceof ICAL.Time) {
		endsAt = resolveTime(dtend, tzidOf(dtendProperty), ctx, label).at;
	} else if (duration instanceof ICAL.Duration) {
		endsAt = new Date(start.at.getTime() + duration.toSeconds() * 1000);
	} else if (dtstart.isDate) {
		// A DATE without DTEND lasts the day (RFC 5545 3.6.1).
		endsAt = dateFromZonedFields(new Date(Date.UTC(dtstart.year, dtstart.month - 1, dtstart.day + 1)), start.timeZone ?? ctx.floatingZone);
	} else {
		endsAt = start.at;
	}
	if (endsAt < start.at) {
		note(`${label}: DTEND before DTSTART, skipped`);
		return null;
	}
	// The zone the expander will actually use: the stored zone, else UTC.
	const expandZone = start.timeZone ?? "UTC";
	const wall = zonedDateFields(start.at, expandZone);
	const probe: RecurrenceProbe = { repeat: "none", repeatDays: "[]", repeatInterval: 1, repeatWeekday: null, repeatWeek: null, repeatAnchorDay: null, timeZone: start.timeZone, repeatUntil: null, startsAt: start.at };
	let mapped: MappedRepeat | null = null;
	let repeatUntil: Date | null = null;
	const repeatParts = allowRrule ? master.getAllProperties("rrule") : [];
	let rule: ICAL.Recur | null = null;
	if (repeatParts.length > 1) {
		note(`${label}: multiple RRULEs are not supported; imported as a single occurrence`);
	} else if (repeatParts.length === 1) {
		try {
			rule = repeatParts[0].getFirstValue() as ICAL.Recur;
		} catch {
			note(`${label}: unreadable RRULE; imported as a single occurrence`);
		}
	}
	if (rule) {
		const { map, reason } = mapRrule(rule, wall);
		if (!map) {
			note(`${label}: ${reason}; imported as a single occurrence`);
		} else {
			mapped = map;
			if (start.fileZoneOnly) note(`${label}: TZID is only defined by the file's VTIMEZONE; recurrences are computed in UTC`);
			Object.assign(probe, { repeat: map.repeat, repeatDays: JSON.stringify(map.repeatDays), repeatInterval: map.repeatInterval, repeatWeekday: map.repeatWeekday, repeatWeek: map.repeatWeek, repeatAnchorDay: map.repeatAnchorDay });
			if (rule.until instanceof ICAL.Time) repeatUntil = untilBound(rule.until, expandZone);
			if (Number.isInteger(rule.count) && (rule.count as number) >= 1) {
				const bound = countBound(probe, rule.count as number, expandZone, ctx, label);
				if (bound && (!repeatUntil || bound < repeatUntil)) repeatUntil = bound;
			}
			probe.repeatUntil = repeatUntil;
		}
	}
	const repeat = mapped?.repeat ?? "none";

	const excluded = new Set<number>();
	const overrides = new Map<number, PendingOverride>();
	const masters = [master, ...extraMasters];
	// EXDATE from every master VEVENT of the UID (a split series shares one set).
	for (const source of masters) {
		for (const property of source.getAllProperties("exdate")) {
			for (const value of property.getValues()) {
				if (value instanceof ICAL.Time) excluded.add(resolveTime(value, tzidOf(property), ctx, label).at.getTime());
			}
		}
	}
	const durationMs = endsAt.getTime() - start.at.getTime();
	for (const source of masters) {
		for (const property of source.getAllProperties("rdate")) {
			for (const value of property.getValues()) {
				if (value instanceof ICAL.Period) {
					const extraStart = resolveTime(value.start, tzidOf(property), ctx, label).at;
					// getEnd computes the instant for the start/duration form too (end is null there).
					const extraEnd = resolveTime(value.getEnd(), tzidOf(property), ctx, label).at;
					if (!excluded.has(extraStart.getTime())) overrides.set(extraStart.getTime(), { occurrenceMs: extraStart.getTime(), startsAt: extraStart, endsAt: extraEnd, title: null, description: null, location: null });
				} else if (value instanceof ICAL.Time) {
					const extraStart = resolveTime(value, tzidOf(property), ctx, label).at;
					const occurrenceMs = extraStart.getTime();
					// An RDATE that restates a rule occurrence adds nothing; an excluded one stays excluded.
					if (excluded.has(occurrenceMs) || isSeriesOccurrence(probe, occurrenceMs)) continue;
					overrides.set(occurrenceMs, { occurrenceMs, startsAt: extraStart, endsAt: new Date(occurrenceMs + durationMs), title: null, description: null, location: null });
				}
			}
		}
	}
	// DTSTART is always an instance; when the mapped rule cannot produce it (a foreign BYDAY that
	// skips its weekday) an extra at the same instant restores it.
	if (repeat !== "none" && !excluded.has(start.at.getTime()) && !isSeriesOccurrence(probe, start.at.getTime())) {
		overrides.set(start.at.getTime(), { occurrenceMs: start.at.getTime(), startsAt: start.at, endsAt, title: null, description: null, location: null });
	}
	for (const exception of detached) {
		const ridProperty = exception.getFirstProperty("recurrence-id");
		const rid = ridProperty?.getFirstValue();
		if (!(rid instanceof ICAL.Time)) {
			note(`${label}: detached occurrence without a valid RECURRENCE-ID, skipped`);
			continue;
		}
		const range = ridProperty?.getParameter("range");
		if (typeof range === "string" && range.toUpperCase() !== "THIS") {
			note(`${label}: RECURRENCE-ID RANGE=${range} is not supported, occurrence skipped`);
			continue;
		}
		const occurrenceMs = resolveTime(rid, tzidOf(ridProperty), ctx, label).at.getTime();
		if (String(exception.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") {
			overrides.delete(occurrenceMs);
			excluded.add(occurrenceMs);
			continue;
		}
		const exStartProperty = exception.getFirstProperty("dtstart");
		const exStart = exStartProperty?.getFirstValue();
		if (!(exStart instanceof ICAL.Time)) {
			note(`${label}: detached occurrence without DTSTART, skipped`);
			continue;
		}
		const exStartAt = resolveTime(exStart, tzidOf(exStartProperty), ctx, label).at;
		const exEndProperty = exception.getFirstProperty("dtend");
		const exEnd = exEndProperty?.getFirstValue();
		const exEndsAt = exEnd instanceof ICAL.Time
			? resolveTime(exEnd, tzidOf(exEndProperty), ctx, label).at
			: new Date(exStartAt.getTime() + durationMs);
		const override = overrides.get(occurrenceMs) ?? { occurrenceMs, startsAt: exStartAt, endsAt: exEndsAt, title: null, description: null, location: null };
		override.startsAt = exStartAt;
		override.endsAt = exEndsAt;
		// The download restates effective text on detached events; a property present in the file is
		// stored verbatim, an absent one keeps inheriting the series value.
		if (exception.hasProperty("summary")) override.title = textValue(exception, "summary");
		if (exception.hasProperty("description")) override.description = textValue(exception, "description");
		if (exception.hasProperty("location")) override.location = textValue(exception, "location");
		overrides.set(occurrenceMs, override);
	}
	for (const ms of excluded) overrides.delete(ms);
	const summary = textValue(master, "summary").trim();
	const row: Omit<ImportEventRow, "id"> = {
		userId: "",
		mailboxId: null,
		title: summary || "(untitled)",
		description: textValue(master, "description"),
		location: textValue(master, "location"),
		attendees: JSON.stringify(mapAttendees(master, label, ctx)),
		color: normalizeCalendarColor(textValue(master, "color") || undefined),
		repeat,
		repeatDays: JSON.stringify(mapped?.repeatDays ?? []),
		repeatAnchorDay: mapped?.repeatAnchorDay ?? null,
		repeatUntil,
		repeatInterval: mapped?.repeatInterval ?? 1,
		repeatWeekday: mapped?.repeatWeekday ?? null,
		repeatWeek: mapped?.repeatWeek ?? null,
		excludedOccurrences: JSON.stringify([...excluded].sort((a, b) => a - b)),
		timeZone: start.timeZone,
		startsAt: start.at,
		endsAt,
		reminderMinutes: mapReminder(master, start.at, label, ctx),
	};
	if (String(master.getFirstPropertyValue("status") ?? "").toUpperCase() === "TENTATIVE") {
		note(`${label}: STATUS:TENTATIVE has no app equivalent on an imported event`);
	}
	if (master.hasProperty("organizer")) note(`${label}: ORGANIZER is not stored on imported events`);
	return { row, probe, overrides };
}

function groupLabel(uid: string | null, index: number, summary: string): string {
	const name = summary ? ` "${summary.slice(0, 60)}"` : "";
	return uid ? `event ${uid}${name}` : `event #${index + 1}${name}`;
}

/**
 * Turns the .ics text into rows ready to insert. Deterministic ids make a byte-identical re-import
 * a no-op against a previous import of the same user. `floatingZone` (the request/user zone) is
 * where floating times and unknown TZIDs resolve; it is also the zone stored on those events.
 */
export async function prepareCalendarImport(text: string, options: { userId: string; floatingZone?: string; idScheme?: ImportIdScheme }): Promise<PreparedCalendarImport> {
	const errors: string[] = [];
	let suppressed = 0;
	const note = (message: string) => {
		if (errors.length < MAX_IMPORT_ERRORS) errors.push(message);
		else suppressed += 1;
	};
	let parsed: unknown;
	try {
		parsed = ICAL.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		// Parser diagnostics carry a useful message; an internal TypeError on non-calendar bytes does not.
		throw new IcsParseError(error instanceof Error && !(error instanceof TypeError) ? error.message : "not an iCalendar file");
	}
	// Concatenated VCALENDAR documents parse to a list of jCals; one document is a single jCal.
	const documents = (Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed : [parsed]) as unknown[];
	const ctx: ZoneContext = { floatingZone: normalizeTimeZone(options.floatingZone), vtimezones: new Map(), note };
	const scheme = options.idScheme ?? importIdScheme(options.userId);
	let calendarName: string | null = null;
	const vevents: ICAL.Component[] = [];
	for (const document of documents) {
		const component = new ICAL.Component(document as ConstructorParameters<typeof ICAL.Component>[0]);
		if (component.name !== "vcalendar") throw new IcsParseError("not a VCALENDAR document");
		if (calendarName === null) {
			const name = component.getFirstPropertyValue("x-wr-calname");
			if (typeof name === "string" && name.trim()) calendarName = name.trim();
		}
		for (const sub of component.getAllSubcomponents("vtimezone")) {
			try {
				const timezone = new ICAL.Timezone(sub);
				if (timezone.tzid) ctx.vtimezones.set(timezone.tzid, timezone);
			} catch { /* A zone the file describes badly just does not resolve below. */ }
		}
		vevents.push(...component.getAllSubcomponents("vevent"));
	}
	if (!vevents.length) throw new IcsParseError("the file contains no events");
	if (vevents.length > MAX_IMPORT_EVENTS) throw new IcsLimitError(`calendar imports accept at most ${MAX_IMPORT_EVENTS} events (got ${vevents.length})`);

	type Group = { uid: string | null; masters: ICAL.Component[]; detached: ICAL.Component[] };
	const groups = new Map<string, Group>();
	let anonymous = 0;
	for (const vevent of vevents) {
		const uid = textValue(vevent, "uid").trim() || null;
		const key = uid ?? ` anonymous-${anonymous++}`;
		const group = groups.get(key) ?? { uid, masters: [], detached: [] };
		if (vevent.hasProperty("recurrence-id")) group.detached.push(vevent);
		else group.masters.push(vevent);
		groups.set(key, group);
	}

	const events: ImportEventRow[] = [];
	const overrides: ImportOverrideRow[] = [];
	let skipped = 0;
	let groupIndex = 0;
	for (const group of groups.values()) {
		const label = groupLabel(group.uid, groupIndex, group.masters[0] ? textValue(group.masters[0], "summary") : textValue(group.detached[0], "summary"));
		groupIndex += 1;
		try {
			if (!group.masters.length) {
				// Orphaned detached occurrences (Google exports them when a series shrank): each one is
				// still a real event, imported standalone with its RECURRENCE-ID ignored for content
				// but used for identity — it is what tells this orphan from the series' other orphans.
				for (const orphan of group.detached) {
					const built = buildGroup(orphan, [], [], ctx, label, note, false);
					if (built) {
						const ridProperty = orphan.getFirstProperty("recurrence-id");
						const rid = ridProperty?.getFirstValue();
						const ridMs = rid instanceof ICAL.Time ? resolveTime(rid, tzidOf(ridProperty), ctx, label).at.getTime() : null;
						const row = await finishEvent(built, group.uid !== null && ridMs !== null ? `${group.uid}#${ridMs}` : null, options.userId, scheme);
						events.push(row.event);
						overrides.push(...row.overrides);
						note(`${label}: a detached occurrence without its series was imported as a single event`);
					} else skipped += 1;
				}
				continue;
			}
			const master = group.masters[group.masters.length - 1];
			if (group.masters.length > 1) note(`${label}: ${group.masters.length} VEVENTs share a UID; merged (last one wins, dates unioned)`);
			const built = buildGroup(master, group.detached, group.masters.slice(0, -1), ctx, label, note);
			if (!built) {
				skipped += 1;
				continue;
			}
			const row = await finishEvent(built, group.uid, options.userId, scheme);
			events.push(row.event);
			overrides.push(...row.overrides);
		} catch (error) {
			skipped += 1;
			note(`${label}: ${error instanceof Error ? error.message : "could not be imported"}`);
		}
	}
	if (suppressed) errors.push(`+${suppressed} more import notes`);
	return { events, overrides, calendarName, skipped, errors };
}

/**
 * The deterministic event id. `seed` is the stable identity the file provides — the UID, or
 * UID#RECURRENCE-ID for an orphaned detached occurrence — so re-importing a revision finds the same
 * row and updates it. Without a seed (no UID at all) the id hashes every stored field instead: an
 * unchanged re-import is skipped, and a changed file produces a second event because nothing ties
 * it to the first.
 */
async function finishEvent(built: BuiltEvent, seed: string | null, userId: string, scheme: ImportIdScheme): Promise<{ event: ImportEventRow; overrides: ImportOverrideRow[] }> {
	const { row, overrides } = built;
	const material = JSON.stringify([row.title, row.description, row.location, row.attendees, row.color, row.repeat, row.repeatDays, row.repeatAnchorDay, row.repeatUntil?.getTime() ?? null, row.repeatInterval, row.repeatWeekday, row.repeatWeek, row.excludedOccurrences, row.timeZone, row.startsAt.getTime(), row.endsAt.getTime(), row.reminderMinutes]);
	const id = `${scheme.prefix}_${await sha256Hex(seed === null ? scheme.fieldsMaterial(material) : scheme.seedMaterial(seed))}`;
	const overrideRows = [...overrides.values()].sort((a, b) => a.occurrenceMs - b.occurrenceMs);
	const overrideIds = await Promise.all(overrideRows.map((override) => sha256Hex(scheme.overrideMaterial(id, override.occurrenceMs))));
	return {
		event: { ...row, id, userId },
		overrides: overrideRows.map((override, index) => ({ ...override, id: `${scheme.prefix}_${overrideIds[index]}`, eventId: id })),
	};
}
