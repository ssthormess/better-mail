import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { chunkIds } from "@/lib/calendar/chunks";
import { IcsLimitError, IcsParseError, MAX_IMPORT_BYTES, prepareCalendarImport, type ImportEventRow, type ImportOverrideRow, type PreparedCalendarImport } from "@/lib/calendar/ics-import";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readFormDataBody, readRawBody } from "@/lib/http/request";
import { getRequestTimeZone } from "@/lib/time/utils";

/**
 * One-shot .ics upload — the write side of GET /api/export/calendar. Synchronous: a typical file is
 * KBs, and the cap (MAX_IMPORT_BYTES / MAX_IMPORT_EVENTS) bounds the work well under a request.
 * Accepts a raw text/calendar (or octet-stream) body, or multipart/form-data with the file in any
 * field. Floating times resolve in the request zone (?timeZone=, X-Time-Zone, then the user's
 * stored zone), the same chain event creation uses. Import ids are stable identity hashes, so a
 * revised file upserts the events it first created instead of duplicating or going stale.
 */
async function readIcsBody(request: Request): Promise<string> {
	if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
		const form = await readFormDataBody(request, MAX_IMPORT_BYTES);
		const file = [...form.values()].find((value): value is File => value instanceof File && value.size > 0);
		return file ? file.text() : "";
	}
	return new TextDecoder("utf-8").decode(await readRawBody(request, MAX_IMPORT_BYTES));
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	let text: string;
	try {
		text = await readIcsBody(request);
	} catch (bodyError) {
		if (bodyError instanceof RequestBodyTooLargeError) {
			return NextResponse.json({ error: "IMPORT_LIMIT_EXCEEDED", detail: `calendar imports accept at most ${MAX_IMPORT_BYTES} bytes` }, { status: 413 });
		}
		return NextResponse.json({ error: "Invalid import upload" }, { status: 400 });
	}
	if (!text.trim()) return NextResponse.json({ error: "Empty calendar file" }, { status: 400 });
	let prepared: PreparedCalendarImport;
	try {
		prepared = await prepareCalendarImport(text, { userId: user.id, floatingZone: getRequestTimeZone(request, user.timeZone) });
	} catch (parseError) {
		if (parseError instanceof IcsLimitError) return NextResponse.json({ error: "IMPORT_LIMIT_EXCEEDED", detail: parseError.message }, { status: 413 });
		if (parseError instanceof IcsParseError) return NextResponse.json({ error: "INVALID_ICS", detail: parseError.message }, { status: 400 });
		throw parseError;
	}
	const db = getDb(env);
	// Event ids are stable identity hashes scoped to the user. An id that already exists is the same
	// event the file describes again: the file is the newer snapshot, so its fields update in place
	// and the response counts the row as updated rather than silently skipping it.
	const existingById = new Map<string, typeof calendarEvents.$inferSelect>();
	for (const chunk of chunkIds(prepared.events.map((event) => event.id))) {
		for (const row of await db.select().from(calendarEvents).where(and(inArray(calendarEvents.id, chunk), eq(calendarEvents.userId, user.id)))) existingById.set(row.id, row);
	}
	const writableIds = new Set(prepared.events.map((event) => event.id));
	// Overrides upsert on the table's natural key (eventId, occurrenceMs): an occurrence the file
	// still describes is inserted when missing or updated when its content moved, while overrides
	// the file no longer mentions — a UI edit, or one a different file added — are left alone.
	// An import adds and updates; it never deletes user data.
	const existingPairs = new Map<string, typeof calendarEventOverrides.$inferSelect>();
	for (const chunk of chunkIds([...writableIds].filter((id) => existingById.has(id)))) {
		for (const row of await db.select().from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk))) {
			existingPairs.set(`${row.eventId}:${row.occurrenceMs}`, row);
		}
	}
	const overridesByEvent = new Map<string, ImportOverrideRow[]>();
	for (const override of prepared.overrides) {
		if (!writableIds.has(override.eventId)) continue;
		const list = overridesByEvent.get(override.eventId) ?? [];
		list.push(override);
		overridesByEvent.set(override.eventId, list);
	}
	// Each event's master row plus all of its override rows commit in one batch — an event is the
	// atomic unit, so a database failure leaves complete events before it and zero rows for the
	// event that failed, never a master split from its detached occurrences. Whole-file atomicity
	// is deliberately not used: one bad event should not roll back an entire honest file, and a
	// batch per event keeps transactions small. A failure reports exactly what was applied.
	const changed = new Set<string>();
	let imported = 0;
	let unchanged = 0;
	let overridesWritten = 0;
	let failed: { index: number; event: ImportEventRow; error: unknown } | null = null;
	for (const [index, event] of prepared.events.entries()) {
		const existing = existingById.get(event.id);
		const statements: BatchItem<"sqlite">[] = [];
		let eventOverrides = 0;
		if (!existing) {
			statements.push(db.insert(calendarEvents).values(event));
		} else if (masterDiffers(existing, event)) {
			statements.push(db.update(calendarEvents).set({ ...masterFields(event), updatedAt: new Date() }).where(eq(calendarEvents.id, event.id)));
		}
		for (const override of overridesByEvent.get(event.id) ?? []) {
			const prior = existingPairs.get(`${override.eventId}:${override.occurrenceMs}`);
			if (!prior) {
				statements.push(db.insert(calendarEventOverrides).values(override));
			} else if (overrideDiffers(prior, override)) {
				statements.push(db.update(calendarEventOverrides).set({ startsAt: override.startsAt, endsAt: override.endsAt, title: override.title, description: override.description, location: override.location, updatedAt: new Date() }).where(eq(calendarEventOverrides.id, prior.id)));
			} else continue;
			eventOverrides += 1;
		}
		if (!statements.length) {
			if (existing) unchanged += 1;
			continue;
		}
		try {
			await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
		} catch (error) {
			failed = { index, event, error };
			break;
		}
		if (existing) changed.add(event.id);
		else imported += 1;
		overridesWritten += eventOverrides;
	}
	const errors = [...prepared.errors];
	if (unchanged) errors.push(`${unchanged} unchanged event(s) already imported; skipped`);
	if (failed) {
		const { index, event, error } = failed;
		const label = `event #${index + 1}${event.title === "(untitled)" ? "" : ` "${event.title.slice(0, 60)}"`}`;
		const applied = imported + changed.size + unchanged;
		const unattempted = prepared.events.length - applied - 1;
		return NextResponse.json(
			{
				error: "IMPORT_PARTIAL_FAILURE",
				detail: `${label} could not be written: ${error instanceof Error ? error.message : "database error"}. The ${applied} event(s) before it stay applied; ${unattempted} were not attempted.`,
				imported,
				updated: changed.size,
				overrides: overridesWritten,
				skipped: prepared.skipped + unchanged,
				failed: 1,
				unattempted,
				errors,
			},
			{ status: 500 },
		);
	}
	return NextResponse.json({ imported, updated: changed.size, overrides: overridesWritten, skipped: prepared.skipped + unchanged, errors });
}

/** The event columns an import owns — identity (id/userId), mailbox linkage and invite state are never touched. */
const MASTER_COLUMNS = ["title", "description", "location", "attendees", "color", "repeat", "repeatDays", "repeatAnchorDay", "repeatUntil", "repeatInterval", "repeatWeekday", "repeatWeek", "excludedOccurrences", "timeZone", "startsAt", "endsAt", "reminderMinutes"] as const;

function masterFields(event: ImportEventRow): Partial<typeof calendarEvents.$inferInsert> {
	return Object.fromEntries(MASTER_COLUMNS.map((column) => [column, event[column]])) as Partial<typeof calendarEvents.$inferInsert>;
}

const instant = (value: unknown): number | null => (value instanceof Date ? value.getTime() : null);

function masterDiffers(existing: typeof calendarEvents.$inferSelect, event: ImportEventRow): boolean {
	return MASTER_COLUMNS.some((column) => {
		const a = existing[column];
		const b = event[column];
		return a instanceof Date || b instanceof Date ? instant(a) !== instant(b) : a !== b;
	});
}

const OVERRIDE_COLUMNS = ["startsAt", "endsAt", "title", "description", "location"] as const;

function overrideDiffers(existing: typeof calendarEventOverrides.$inferSelect, override: ImportOverrideRow): boolean {
	return OVERRIDE_COLUMNS.some((column) => {
		const a = existing[column];
		const b = override[column];
		return a instanceof Date || b instanceof Date ? instant(a) !== instant(b) : a !== b;
	});
}
