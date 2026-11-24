import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
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
	const changed = new Set<string>();
	let imported = 0;
	for (const event of prepared.events) {
		const existing = existingById.get(event.id);
		if (!existing) {
			await db.insert(calendarEvents).values(event);
			imported += 1;
			continue;
		}
		if (masterDiffers(existing, event)) {
			await db.update(calendarEvents).set({ ...masterFields(event), updatedAt: new Date() }).where(eq(calendarEvents.id, event.id));
			changed.add(event.id);
		}
	}
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
	let overridesWritten = 0;
	for (const override of prepared.overrides) {
		if (!writableIds.has(override.eventId)) continue;
		const existing = existingPairs.get(`${override.eventId}:${override.occurrenceMs}`);
		if (!existing) {
			await db.insert(calendarEventOverrides).values(override);
		} else if (overrideDiffers(existing, override)) {
			await db.update(calendarEventOverrides).set({ startsAt: override.startsAt, endsAt: override.endsAt, title: override.title, description: override.description, location: override.location, updatedAt: new Date() }).where(eq(calendarEventOverrides.id, existing.id));
		} else continue;
		overridesWritten += 1;
		if (existingById.has(override.eventId)) changed.add(override.eventId);
	}
	const unchanged = [...existingById.keys()].filter((id) => !changed.has(id)).length;
	const errors = [...prepared.errors];
	if (unchanged) errors.push(`${unchanged} unchanged event(s) already imported; skipped`);
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
