import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarSubscriptions } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { authorizeCalendarRequest } from "@/lib/calendar/api-auth";
import { readJsonObject } from "@/lib/http/request";
import { MAX_REFRESH_INTERVAL_SEC, MIN_REFRESH_INTERVAL_SEC, normalizeRefreshIntervalSec } from "@/lib/calendar/subscriptions";
import type { CalendarSubscriptionRouteParams } from "./types";

type SubscriptionPatch = { title?: unknown; refreshIntervalSec?: unknown };

export async function PATCH(request: Request, { params }: CalendarSubscriptionRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const { subscriptionId } = await params;
	const input = await readJsonObject<SubscriptionPatch>(request);
	if (!input) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	const db = getDb(env);
	const [existing] = await db.select().from(calendarSubscriptions).where(and(eq(calendarSubscriptions.id, subscriptionId), eq(calendarSubscriptions.userId, user.id))).limit(1);
	if (!existing) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
	const updates: Partial<Pick<typeof calendarSubscriptions.$inferInsert, "title" | "refreshIntervalSec">> = {};
	if (input.title !== undefined) {
		if (typeof input.title !== "string" || !input.title.trim()) return NextResponse.json({ error: "Enter a title" }, { status: 400 });
		updates.title = input.title.trim().slice(0, 200);
	}
	if (input.refreshIntervalSec !== undefined) {
		const interval = normalizeRefreshIntervalSec(input.refreshIntervalSec);
		if (interval === null) return NextResponse.json({ error: `Refresh interval must be ${MIN_REFRESH_INTERVAL_SEC}-${MAX_REFRESH_INTERVAL_SEC} seconds` }, { status: 400 });
		updates.refreshIntervalSec = interval;
	}
	if (!Object.keys(updates).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
	const updatedAt = new Date();
	await db.update(calendarSubscriptions).set({ ...updates, updatedAt }).where(eq(calendarSubscriptions.id, existing.id));
	return NextResponse.json({ subscription: { ...existing, ...updates, updatedAt } });
}

/** Unsubscribing deletes the feed row; its evt_s_ events and their overrides follow by cascade. */
export async function DELETE(request: Request, { params }: CalendarSubscriptionRouteParams) {
	const env = getEnv();
	const { user, error } = await authorizeCalendarRequest(env, request, "calendar:write");
	if (error) return error;
	const { subscriptionId } = await params;
	const db = getDb(env);
	const [existing] = await db.select({ id: calendarSubscriptions.id }).from(calendarSubscriptions).where(and(eq(calendarSubscriptions.id, subscriptionId), eq(calendarSubscriptions.userId, user.id))).limit(1);
	if (!existing) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
	await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.id, existing.id));
	return NextResponse.json({ ok: true });
}
