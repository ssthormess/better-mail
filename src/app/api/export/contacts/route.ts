import { NextResponse } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { addressesSeenInMailbox } from "@/app/api/contacts/utils";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { contactsToCsv } from "@/lib/export/csv";
import { contactsToVcf } from "@/lib/export/vcard";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Mailbox is required" }, { status: 400 });
	// vCard stays the default so existing ?mailboxId= links keep working.
	const format = url.searchParams.get("format") ?? "vcf";
	if (format !== "vcf" && format !== "csv") {
		return NextResponse.json({ error: "Unsupported format" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	// Contacts belong to the mailbox's owner, so a shared mailbox exports its
	// owner's address book — the same list GET /api/contacts shows.
	let rows = await db
		.select({ email: contacts.email, displayName: contacts.displayName, blocked: contacts.blocked })
		.from(contacts)
		.where(eq(contacts.userId, access.mailbox.userId))
		.orderBy(
			asc(sql`lower(coalesce(${contacts.displayName}, ${contacts.email}))`),
			asc(contacts.email),
		);

	if (!access.isOwner) {
		// A delegate sees only addresses on this mailbox's mail, so that is all their export holds.
		const seen = await addressesSeenInMailbox(db, access.mailbox.id, rows.map((row) => row.email), user.id);
		rows = rows.filter((row) => seen.has(row.email));
	}

	if (format === "csv") {
		return new Response(contactsToCsv(rows), {
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="contacts.csv"`,
				"Cache-Control": "no-store",
			},
		});
	}

	return new Response(contactsToVcf(rows), {
		headers: {
			"Content-Type": "text/vcard; charset=utf-8",
			"Content-Disposition": `attachment; filename="contacts.vcf"`,
			"Cache-Control": "no-store",
		},
	});
}
