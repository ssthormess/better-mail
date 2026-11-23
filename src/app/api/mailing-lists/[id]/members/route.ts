import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { mailingListMembers } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { normalizeEmailAddress } from "@/lib/email/address";
import { newId } from "@/lib/ids";
import { readJsonObject } from "@/lib/http/request";
import { mailingListMemberSchema, updateMailingListMemberSchema } from "@/lib/validators";
import type { MailingListRouteParams } from "../types";
import { getOwnedList, listMembers } from "../../utils";

export async function GET(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });

	return NextResponse.json({ members: await listMembers(db, id) });
}

export async function POST(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = mailingListMemberSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });

	const members = await listMembers(db, id);
	const email = normalizeEmailAddress(parsed.data.email);
	// Posting compares member addresses normalized, so a duplicate check must
	// too: `Bob@x` and `bob@x` are the same subscription.
	if (members.some((member) => normalizeEmailAddress(member.email) === email)) {
		return NextResponse.json({ error: "This address is already a member of the list" }, { status: 409 });
	}

	await db.insert(mailingListMembers).values({
		id: newId("mem"),
		listId: id,
		email,
		name: parsed.data.name || null,
		role: parsed.data.role ?? "member",
		moderated: parsed.data.moderated ?? false,
	});

	return NextResponse.json({ members: await listMembers(db, id) });
}

export async function PATCH(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = updateMailingListMemberSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });

	const [member] = await db
		.select()
		.from(mailingListMembers)
		.where(and(eq(mailingListMembers.id, parsed.data.memberId), eq(mailingListMembers.listId, id)))
		.limit(1);
	if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

	const updates: Partial<Pick<typeof mailingListMembers.$inferSelect, "name" | "role" | "moderated">> = {};
	if (parsed.data.name !== undefined) updates.name = parsed.data.name;
	if (parsed.data.role !== undefined) updates.role = parsed.data.role;
	if (parsed.data.moderated !== undefined) updates.moderated = parsed.data.moderated;
	if (Object.keys(updates).length === 0) {
		return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
	}
	await db.update(mailingListMembers).set(updates).where(eq(mailingListMembers.id, member.id));

	return NextResponse.json({ members: await listMembers(db, id) });
}

export async function DELETE(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const memberId = new URL(request.url).searchParams.get("memberId");
	if (!memberId) return NextResponse.json({ error: "Member is required" }, { status: 400 });

	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });

	const [member] = await db
		.select({ id: mailingListMembers.id })
		.from(mailingListMembers)
		.where(and(eq(mailingListMembers.id, memberId), eq(mailingListMembers.listId, id)))
		.limit(1);
	if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

	await db.delete(mailingListMembers).where(eq(mailingListMembers.id, member.id));
	return NextResponse.json({ members: await listMembers(db, id) });
}
