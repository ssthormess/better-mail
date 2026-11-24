import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { chunkIds } from "@/lib/calendar/chunks";
import { IcsLimitError, IcsParseError, MAX_IMPORT_BYTES, prepareCalendarImport, type PreparedCalendarImport } from "@/lib/calendar/ics-import";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readFormDataBody, readRawBody } from "@/lib/http/request";
import { getRequestTimeZone } from "@/lib/time/utils";

/**
 * One-shot .ics upload — the write side of GET /api/export/calendar. Synchronous: a typical file is
 * KBs, and the cap (MAX_IMPORT_BYTES / MAX_IMPORT_EVENTS) bounds the work well under a request.
 * Accepts a raw text/calendar (or octet-stream) body, or multipart/form-data with the file in any
 * field. Floating times resolve in the request zone (?timeZone=, X-Time-Zone, then the user's
 * stored zone), the same chain event creation uses. Import ids are content hashes, so re-uploading
 * an unchanged file is a no-op rather than a second copy of everything.
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
	// Event ids are deterministic content hashes scoped to the user, so an id that already exists
	// is an unchanged re-import and is skipped. A changed file collides on nothing and inserts new.
	const existingEvents = new Set<string>();
	for (const chunk of chunkIds(prepared.events.map((event) => event.id))) {
		for (const row of await db.select({ id: calendarEvents.id }).from(calendarEvents).where(inArray(calendarEvents.id, chunk))) existingEvents.add(row.id);
	}
	const toInsert = prepared.events.filter((event) => !existingEvents.has(event.id));
	const writableIds = new Set(prepared.events.map((event) => event.id));
	for (const event of toInsert) await db.insert(calendarEvents).values(event);
	// Overrides dedupe on the table's natural key (eventId, occurrenceMs): an occurrence that already
	// has an override — from an earlier import or a UI edit — is left alone, while new extras and
	// exceptions on an already-imported series still land.
	const existingPairs = new Set<string>();
	for (const chunk of chunkIds([...writableIds])) {
		for (const row of await db.select({ eventId: calendarEventOverrides.eventId, occurrenceMs: calendarEventOverrides.occurrenceMs }).from(calendarEventOverrides).where(inArray(calendarEventOverrides.eventId, chunk))) {
			existingPairs.add(`${row.eventId}:${row.occurrenceMs}`);
		}
	}
	let overridesWritten = 0;
	for (const override of prepared.overrides) {
		if (!writableIds.has(override.eventId) || existingPairs.has(`${override.eventId}:${override.occurrenceMs}`)) continue;
		await db.insert(calendarEventOverrides).values(override);
		overridesWritten += 1;
	}
	const duplicates = prepared.events.length - toInsert.length;
	const errors = [...prepared.errors];
	if (duplicates) errors.push(`${duplicates} unchanged event(s) already imported; skipped`);
	return NextResponse.json({ imported: toInsert.length, overrides: overridesWritten, skipped: prepared.skipped + duplicates, errors });
}
