import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { mailingLists } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { readJsonObject } from "@/lib/http/request";
import { updateMailingListSchema } from "@/lib/validators";
import type { MailingListRouteParams } from "./types";
import { getOwnedList, listAddressStillClaimed, listMembers, listResponse } from "../utils";

export async function GET(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });

	const members = await listMembers(db, id);
	return NextResponse.json({
		list: { ...listResponse(owned.list, owned.domain.hostname), memberCount: members.length },
		members,
	});
}

export async function PATCH(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = updateMailingListSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });
	const { list, domain } = owned;

	const updates: Partial<Pick<typeof mailingLists.$inferSelect, "name" | "description" | "postingPolicy" | "moderated" | "disabled">> = {};
	if (parsed.data.name !== undefined) updates.name = parsed.data.name;
	if (parsed.data.description !== undefined) updates.description = parsed.data.description;
	if (parsed.data.postingPolicy !== undefined) updates.postingPolicy = parsed.data.postingPolicy;
	if (parsed.data.moderated !== undefined) updates.moderated = parsed.data.moderated;
	if (parsed.data.disabled !== undefined) updates.disabled = parsed.data.disabled;
	if (Object.keys(updates).length === 0) {
		return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
	}

	// Re-enabling must restore delivery too: make sure the Cloudflare rule is
	// there before the worker starts claiming the address again.
	if (updates.disabled === false && list.disabled && domain.receivingProvider === "cloudflare") {
		try {
			await ensureEmailRoutingRuleToWorker(env, domain.zoneId, `${list.localPart}@${domain.hostname}`);
		} catch (error) {
			console.error("ensureEmailRoutingRuleToWorker", error);
			return NextResponse.json(
				{ error: "Failed to restore the Cloudflare Email Routing rule for this list. Please try again." },
				{ status: 502 },
			);
		}
	}
	await db.update(mailingLists).set(updates).where(eq(mailingLists.id, list.id));

	const [updated] = await db.select().from(mailingLists).where(eq(mailingLists.id, list.id)).limit(1);
	return NextResponse.json({ list: listResponse(updated!, domain.hostname) });
}

export async function DELETE(request: Request, { params }: MailingListRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const owned = await getOwnedList(db, user, id);
	if (!owned) return NextResponse.json({ error: "List not found" }, { status: 404 });
	const { list, domain } = owned;

	if (domain.receivingProvider === "cloudflare" && !(await listAddressStillClaimed(db, domain, list))) {
		try {
			await deleteEmailRoutingRuleForAddress(env, domain.zoneId, `${list.localPart}@${domain.hostname}`);
		} catch (error) {
			console.error("deleteEmailRoutingRuleForAddress", error);
			return NextResponse.json(
				{ error: "Failed to remove the Cloudflare Email Routing rule for this list. Please try again." },
				{ status: 502 },
			);
		}
	}

	await db.delete(mailingLists).where(eq(mailingLists.id, list.id));
	return NextResponse.json({ ok: true });
}
