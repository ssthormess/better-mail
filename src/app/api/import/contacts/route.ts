import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { existingContactsSeenInMailbox, getContactByEmail, getExistingContactEmails, saveManualContact } from "@/app/api/contacts/utils";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readFormDataBody } from "@/lib/http/request";
import { hasVCardMarkers, parseCsvContacts } from "@/lib/import/csv";
import { resolveContactImportFormat, type ContactImportFormat } from "@/lib/import/format";
import { decodeTextBytes } from "@/lib/import/text";
import { isVCardDocument, parseVcfContacts } from "@/lib/import/vcard";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getPersonalIdentityForAddress, syncPersonalIdentity } from "@/lib/profile/sync";

// Contact exports stay small; the byte cap keeps a bogus upload from burning
// request time, and the parsers' card/row caps bound the write loop.
const MAX_CONTACT_IMPORT_BYTES = 5 * 1024 * 1024;

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
 * `?format=` convention — and the file picker's branch to the preview dialog
 * runs the same `resolveContactImportFormat`, so neither can drift.
 */
function resolveFormat(form: FormData, file: File): ContactImportFormat | null {
	return resolveContactImportFormat(String(form.get("format") ?? ""), file.name, file.type);
}

/** `conflict` decides what an already-known address does: `update` rewrites its name like POST /api/contacts, `skip` leaves it alone. */
function resolveConflict(form: FormData): ConflictPolicy | null {
	const value = String(form.get("conflict") ?? "").trim().toLowerCase();
	if (value === "" || value === "update") return "update";
	return value === "skip" ? "skip" : null;
}

function parseUpload(format: ContactImportFormat, text: string): ParsedImport {
	if (format === "csv") {
		const parsed = parseCsvContacts(text);
		return {
			contacts: parsed.contacts,
			// Invalid and in-file-duplicate rows read as skipped in the same counters a .vcf uses.
			skipped: parsed.skipped + parsed.rows.filter((row) => row.status !== "ok").length,
			previewSkipped: parsed.skipped,
			rows: parsed.rows,
		};
	}
	const parsed = parseVcfContacts(text);
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
		const text = decodeTextBytes(await file.arrayBuffer());
		// Fail closed: declaration and metadata pick the parser, but the document
		// still has to be that format. A vCard as .csv must not degrade into
		// "EMAIL:a@b" cells, and a CSV as .vcf must not let the card scanner pick
		// a BEGIN:VCARD block out of a quoted cell.
		if ((format === "csv" && hasVCardMarkers(text)) || (format === "vcf" && !isVCardDocument(text))) {
			return NextResponse.json({ error: "The file's contents do not match its contact format" }, { status: 400 });
		}
		parsed = parseUpload(format, text);
	} catch {
		return NextResponse.json({ error: "Unable to read the contact file" }, { status: 400 });
	}

	// A preview classifies each row against the address book without writing —
	// the client re-uploads the file with its chosen conflict policy to confirm,
	// which keeps the whole flow stateless. Existence is looked up in batched
	// IN() statements, not one SELECT per row, so a 2,000-row preview stays
	// inside D1's per-invocation query budget.
	if (preview) {
		const counts = { new: 0, existing: 0, invalid: 0, duplicates: 0, unknown: 0, skipped: parsed.previewSkipped };
		const rows: { row: number; email: string | null; name: string | null; status: string }[] = [];
		const candidates = parsed.rows.flatMap((row) => (row.status === "ok" && row.email ? [row.email] : []));
		// Same visibility rule as GET /api/contacts and the export: a delegate
		// only sees addresses on this mailbox's mail, so their "existing" set is
		// book membership intersected with the mailbox-visible set — one chunked
		// scan computes both, its statement count tracks candidates only, and an
		// existing contact a delegate cannot see reads as new. When that scan
		// fills a candidate's row bound without verifying it, the candidate is
		// "unknown" — the lookup cannot honestly call it absent, and the status
		// fires on the mailbox evidence alone so it never betrays whether the
		// address sits in the owner's private book. Owners classify against
		// their whole book directly.
		let existing: Set<string>;
		let unverified = new Set<string>();
		if (access.isOwner) {
			existing = await getExistingContactEmails(db, ownerId, candidates);
		} else {
			const scoped = await existingContactsSeenInMailbox(db, access.mailbox.id, ownerId, candidates, user.id);
			existing = scoped.existing;
			unverified = scoped.unverified;
		}
		for (const row of parsed.rows) {
			const status =
				row.status === "ok"
					? existing.has(row.email ?? "")
						? "existing"
						: unverified.has(row.email ?? "")
							? "unknown"
							: "new"
					: row.status;
			if (status === "new") counts.new++;
			else if (status === "existing") counts.existing++;
			else if (status === "dup") counts.duplicates++;
			else if (status === "unknown") counts.unknown++;
			else counts.invalid++;
			rows.push({ row: row.row, email: row.email, name: row.displayName ?? null, status });
		}
		return NextResponse.json({ preview: true, counts, rows });
	}

	// Same upsert as POST /api/contacts: an existing contact gets the file's name
	// (an entry without one never clears a stored name). Gravatar avatars are not
	// fetched here — a single add can afford the external lookup, but an import
	// would fan out hundreds of fetches inside one request. The existence check
	// and the write are not atomic: a concurrent insert landing between them can
	// be overwritten by a `skip` row, the same window POST /api/contacts has.
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
