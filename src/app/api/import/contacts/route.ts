import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getContactByEmail, saveManualContact } from "@/app/api/contacts/utils";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readFormDataBody } from "@/lib/http/request";
import { parseCsvContacts } from "@/lib/import/csv";
import { decodeTextBytes } from "@/lib/import/text";
import { parseVcfContacts } from "@/lib/import/vcard";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getPersonalIdentityForAddress, syncPersonalIdentity } from "@/lib/profile/sync";

// Contact exports stay small; the byte cap keeps a bogus upload from burning
// request time, and the parsers' card/row caps bound the write loop.
const MAX_CONTACT_IMPORT_BYTES = 5 * 1024 * 1024;

type ImportFormat = "vcf" | "csv";
type ConflictPolicy = "update" | "skip";

interface ParsedImport {
	contacts: { email: string; displayName: string | undefined }[];
	/** Rows dropped before any write: bad, duplicated and over-cap entries. */
	skipped: number;
	/** Rows a preview cannot classify individually (vCard drops, CSV over-cap). */
	previewSkipped: number;
	/** Per-row classification when the format reports it (CSV); used for previews. */
	rows: { row: number; email: string | null; displayName: string | undefined; status: "ok" | "invalid" | "dup" }[];
}

/**
 * The `format` form field selects the parser, mirroring the export route's
 * `?format=` convention. Without one the upload is sniffed — the filename's
 * extension first, then the content type (browsers send both unreliably), and
 * otherwise vCard so existing clients, which only ever sent .vcf, stay put.
 */
function resolveFormat(form: FormData, file: File): ImportFormat | null {
	const declared = String(form.get("format") ?? "").trim().toLowerCase();
	if (declared === "csv" || declared === "vcf") return declared;
	if (declared) return null;
	if (/\.csv$/i.test(file.name)) return "csv";
	if (/\.(vcf|vcard)$/i.test(file.name)) return "vcf";
	if (/^(text\/csv|application\/vnd\.ms-excel)$/i.test(file.type)) return "csv";
	return "vcf";
}

/** `conflict` decides what an already-known address does: `update` rewrites its name like POST /api/contacts, `skip` leaves it alone. */
function resolveConflict(form: FormData): ConflictPolicy | null {
	const value = String(form.get("conflict") ?? "").trim().toLowerCase();
	if (value === "" || value === "update") return "update";
	return value === "skip" ? "skip" : null;
}

function parseUpload(format: ImportFormat, buffer: ArrayBuffer): ParsedImport {
	if (format === "csv") {
		const parsed = parseCsvContacts(decodeTextBytes(buffer));
		return {
			contacts: parsed.contacts,
			// Invalid and in-file-duplicate rows read as skipped in the same counters a .vcf uses.
			skipped: parsed.skipped + parsed.rows.filter((row) => row.status !== "ok").length,
			previewSkipped: parsed.skipped,
			rows: parsed.rows,
		};
	}
	const parsed = parseVcfContacts(decodeTextBytes(buffer));
	// The vCard parser only surfaces the deduped survivors; sequence them so the
	// preview row numbering stays meaningful (it is an index, not a line number).
	return {
		contacts: parsed.contacts,
		skipped: parsed.skipped,
		previewSkipped: parsed.skipped,
		rows: parsed.contacts.map((contact, index) => ({
			row: index + 1,
			email: contact.email,
			displayName: contact.displayName,
			status: "ok" as const,
		})),
	};
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let form: FormData;
	try {
		form = await readFormDataBody(request, MAX_CONTACT_IMPORT_BYTES);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid contact import upload" }, { status });
	}
	const mailboxId = String(form.get("mailboxId") ?? "");
	const file = form.get("file");
	if (!mailboxId || !(file instanceof File) || file.size === 0) {
		return NextResponse.json({ error: "A mailbox and a .vcf or .csv file are required" }, { status: 400 });
	}
	const format = resolveFormat(form, file);
	if (!format) {
		return NextResponse.json({ error: "Unsupported contact import format" }, { status: 400 });
	}
	const conflict = resolveConflict(form);
	if (!conflict) {
		return NextResponse.json({ error: "Unsupported conflict policy" }, { status: 400 });
	}
	const preview = /^(1|true)$/i.test(String(form.get("preview") ?? "").trim());

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const ownerId = access.mailbox.userId;

	let parsed: ParsedImport;
	try {
		parsed = parseUpload(format, await file.arrayBuffer());
	} catch {
		return NextResponse.json({ error: "Unable to read the contact file" }, { status: 400 });
	}

	// A preview classifies each row against the address book without writing —
	// the client re-uploads the file with its chosen conflict policy to confirm,
	// which keeps the whole flow stateless.
	if (preview) {
		const counts = { new: 0, existing: 0, invalid: 0, duplicates: 0, skipped: parsed.previewSkipped };
		const rows: { row: number; email: string | null; name: string | null; status: string }[] = [];
		for (const row of parsed.rows) {
			let status: "new" | "existing" | "invalid" | "dup";
			if (row.status === "ok") {
				status = (await getContactByEmail(db, ownerId, row.email ?? "")) ? "existing" : "new";
			} else {
				status = row.status;
			}
			if (status === "new") counts.new++;
			else if (status === "existing") counts.existing++;
			else if (status === "dup") counts.duplicates++;
			else counts.invalid++;
			rows.push({ row: row.row, email: row.email, name: row.displayName ?? null, status });
		}
		return NextResponse.json({ preview: true, counts, rows });
	}

	// Same upsert as POST /api/contacts: an existing contact gets the file's name
	// (an entry without one never clears a stored name). Gravatar avatars are not
	// fetched here — a single add can afford the external lookup, but an import
	// would fan out hundreds of fetches inside one request.
	const result = { imported: 0, updated: 0, skipped: parsed.skipped, failed: 0 };
	for (const contact of parsed.contacts) {
		try {
			const existing = await getContactByEmail(db, ownerId, contact.email);
			if (existing && conflict === "skip") {
				result.skipped++;
				continue;
			}
			// The address can be one of the user's own accounts; keep its name in step like POST does.
			const account = await getPersonalIdentityForAddress(db, ownerId, contact.email);
			if (account && account.userId === user.id && contact.displayName) {
				await syncPersonalIdentity(db, {
					userId: account.userId,
					name: contact.displayName,
					avatarKey: account.avatarKey,
				});
			}
			await saveManualContact(db, {
				userId: ownerId,
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
