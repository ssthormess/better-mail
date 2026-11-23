import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getContactByEmail, saveManualContact } from "@/app/api/contacts/utils";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readFormDataBody } from "@/lib/http/request";
import { decodeVcfBytes, parseVcfContacts } from "@/lib/import/vcard";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getPersonalIdentityForAddress, syncPersonalIdentity } from "@/lib/profile/sync";

// Contact exports stay small; the byte cap keeps a bogus "vcf" from burning
// request time, and the parser's card cap bounds the write loop.
const MAX_VCARD_IMPORT_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let form: FormData;
	try {
		form = await readFormDataBody(request, MAX_VCARD_IMPORT_BYTES);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid contact import upload" }, { status });
	}
	const mailboxId = String(form.get("mailboxId") ?? "");
	const file = form.get("file");
	if (!mailboxId || !(file instanceof File) || file.size === 0) {
		return NextResponse.json({ error: "A mailbox and a .vcf file are required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	let parsed: ReturnType<typeof parseVcfContacts>;
	try {
		parsed = parseVcfContacts(decodeVcfBytes(await file.arrayBuffer()));
	} catch {
		return NextResponse.json({ error: "Unable to read the vCard file" }, { status: 400 });
	}

	// Same upsert as POST /api/contacts: an existing contact gets the card's name
	// (a card without FN never clears a stored one). Gravatar avatars are not
	// fetched here — a single add can afford the external lookup, but an import
	// would fan out hundreds of fetches inside one request.
	const result = { imported: 0, updated: 0, skipped: parsed.skipped, failed: 0 };
	for (const contact of parsed.contacts) {
		try {
			// The address can be one of the user's own accounts; keep its name in step like POST does.
			const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, contact.email);
			if (account && account.userId === user.id && contact.displayName) {
				await syncPersonalIdentity(db, {
					userId: account.userId,
					name: contact.displayName,
					avatarKey: account.avatarKey,
				});
			}
			const existing = await getContactByEmail(db, access.mailbox.userId, contact.email);
			await saveManualContact(db, {
				userId: access.mailbox.userId,
				email: contact.email,
				displayName: contact.displayName,
			});
			if (existing) result.updated++;
			else result.imported++;
		} catch {
			result.failed++;
		}
	}
	return NextResponse.json(result);
}
