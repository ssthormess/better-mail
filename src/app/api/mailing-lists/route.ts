import { asc, count, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains, mailingListMembers, mailingLists } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { readJsonObject } from "@/lib/http/request";
import { mailingListSchema } from "@/lib/validators";
import { canUseDomainForAddresses, findListAddressConflict, listResponse } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const rows = await db
		.select({ list: mailingLists, hostname: domains.hostname })
		.from(mailingLists)
		.innerJoin(domains, eq(mailingLists.domainId, domains.id))
		.where(eq(mailingLists.userId, user.id))
		.orderBy(asc(mailingLists.createdAt), asc(mailingLists.id));
	const memberCounts = new Map(
		rows.length === 0
			? []
			: (await db
				.select({ listId: mailingListMembers.listId, total: count() })
				.from(mailingListMembers)
				.where(inArray(mailingListMembers.listId, rows.map((row) => row.list.id)))
				.groupBy(mailingListMembers.listId)
			).map((row) => [row.listId, row.total]),
	);
	return NextResponse.json({
		lists: rows.map((row) => ({
			...listResponse(row.list, row.hostname),
			memberCount: memberCounts.get(row.list.id) ?? 0,
		})),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = mailingListSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const [domain] = await db
		.select()
		.from(domains)
		.where(eq(domains.id, parsed.data.domainId))
		.limit(1);
	if (!domain || !canUseDomainForAddresses(user, domain)) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	// Stored like mailbox local parts — lowercased, dots and +tags kept — the
	// resolver normalizes at lookup time.
	const localPart = parsed.data.localPart.toLowerCase();
	const conflict = await findListAddressConflict(db, domain, localPart);
	if (conflict === "mailbox") {
		return NextResponse.json({ error: "A mailbox already uses this address" }, { status: 409 });
	}
	if (conflict === "alias") {
		return NextResponse.json({ error: "An alias already uses this address" }, { status: 409 });
	}
	if (conflict === "list") {
		return NextResponse.json({ error: "A mailing list already uses this address" }, { status: 409 });
	}

	const id = newId("lst");
	await db.insert(mailingLists).values({
		id,
		userId: user.id,
		domainId: domain.id,
		localPart,
		name: parsed.data.name,
		description: parsed.data.description ?? null,
		postingPolicy: parsed.data.postingPolicy ?? "members_only",
		moderated: parsed.data.moderated ?? false,
	});

	// Worker routes only matter when Cloudflare is what receives this domain's
	// mail; for Resend/SES domains the list resolves inside provider intake.
	if (domain.receivingProvider === "cloudflare") {
		try {
			await ensureEmailRoutingRuleToWorker(env, domain.zoneId, `${localPart}@${domain.hostname}`);
		} catch (error) {
			console.error("ensureEmailRoutingRuleToWorker", error);
			await db.delete(mailingLists).where(eq(mailingLists.id, id));
			return NextResponse.json(
				{ error: "Failed to create the Cloudflare Email Routing rule for this list. Please try again." },
				{ status: 502 },
			);
		}
	}

	const [list] = await db.select().from(mailingLists).where(eq(mailingLists.id, id)).limit(1);
	return NextResponse.json({ list: { ...listResponse(list!, domain.hostname), memberCount: 0 } });
}
