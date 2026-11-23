import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { addressListIncludes } from "@/lib/email/address";
import type { getDb } from "@/db";
import { contacts, messages } from "@/db/schema";
import { concatText, escapeLike, insensitiveLike } from "@/db/sql";
import { schemaDialect } from "@/db/dialect";
import { getContactId } from "@/lib/contacts/utils";

type Db = ReturnType<typeof getDb>;

export const CONTACTS_LIST_MAX_LIMIT = 500;
export const CONTACTS_LIST_DEFAULT_LIMIT = 200;

export function parseContactsLimit(value: string | null): number {
	if (value === null) return CONTACTS_LIST_DEFAULT_LIMIT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return CONTACTS_LIST_DEFAULT_LIMIT;
	return Math.min(parsed, CONTACTS_LIST_MAX_LIMIT);
}

export async function getContactByEmail(db: Db, userId: string, email: string) {
	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, userId), eq(contacts.email, email)))
		.limit(1);
	return contact ?? null;
}

/**
 * Which of `emails` already exist in `userId`'s address book — one batched IN()
 * statement per 90 addresses (D1's 100 bound-parameter cap minus userId) instead
 * of a getContactByEmail round-trip per row, so a 2,000-row import preview stays
 * inside D1's per-invocation query budget.
 */
export async function getExistingContactEmails(db: Db, userId: string, emails: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	const unique = [...new Set(emails)];
	for (let offset = 0; offset < unique.length; offset += 90) {
		const rows = await db
			.select({ email: contacts.email })
			.from(contacts)
			.where(and(eq(contacts.userId, userId), inArray(contacts.email, unique.slice(offset, offset + 90))));
		for (const row of rows) found.add(row.email);
	}
	return found;
}

export async function listContacts(db: Db, input: { userId: string; query: string; limit: number }) {
	const pattern = `%${escapeLike(input.query)}%`;
	const conditions = [eq(contacts.userId, input.userId)];
	if (input.query) {
		conditions.push(
			or(
				insensitiveLike(contacts.email, pattern),
				insensitiveLike(contacts.displayName, pattern),
			)!,
		);
	}
	return db
		.select()
		.from(contacts)
		.where(and(...conditions))
		// Name-less contacts sort by address; lower() keeps ordering consistent across dialects.
		.orderBy(
			asc(sql`lower(coalesce(${contacts.displayName}, ${contacts.email}))`),
			asc(contacts.email),
		)
		.limit(input.limit);
}

// 97 candidates plus the mailbox id, the draftsVisibleTo viewer and the owner
// id reach exactly D1's 100 bound parameters per statement — 21 statements for
// a capped 2000-row upload, with the rows-per-candidate bound inlined (never a
// bound parameter). Statement count tracks candidates only: mailbox size,
// private hit counts and auth can never stretch it past headroom.
const VISIBILITY_CHUNK = 97;
const VISIBILITY_ROWS_PER_CANDIDATE = 16;

interface CandidateRow {
	email: string;
	isContact: boolean;
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
}

/**
 * Whether the stored contact row the join found IS the candidate's address.
 * MySQL's default utf8mb4 collation is accent-insensitive, so `contacts.email =
 * candidate` can match a different stored address — the join returns the stored
 * value and this compare (codepoints, case-folded like the address parser) is
 * the verdict.
 */
export function isExactStoredContact(storedEmail: string | null, email: string): boolean {
	return storedEmail !== null && storedEmail.toLowerCase() === email.toLowerCase();
}

/**
 * Mailbox-corpus scan shared by the visibility checks below. Each statement
 * carries up to VISIBILITY_CHUNK candidates as a UNION-derived table, joins
 * mailbox messages on a case-folded substring hit inside the concatenated
 * from/to/cc corpus, and keeps only the first few matching rows PER CANDIDATE
 * via ROW_NUMBER — a flat LIMIT would let one frequent correspondent crowd
 * another's hits out and misreport a stored contact as new. The window ranks
 * rows where the candidate is a complete address token (the corpus with every
 * address delimiter normalized to a comma contains `,email,`) above plain
 * substring hits, so 16 messages to `xa@b.cc` cannot exhaust `a@b.c`'s bound
 * before its real row. When `ownerUserId` is given, the same pass also returns
 * the stored contact address per candidate, so preview gets visibility and book
 * membership in one stage.
 *
 * The SQL prefilter is deliberately loose: lower() folds ASCII case, so a
 * non-ASCII candidate whose case differs from the stored header can
 * under-match and then fail closed as `new` — the verdict never goes the other
 * way, and a private draft stays visible only to its author. The exact
 * visibility verdict is the local addressListIncludes parse below; substring
 * hits and LIKE false positives cannot pass as real visibility.
 */
async function mailboxCandidateRows(db: Db, mailboxId: string, viewerUserId: string, ownerUserId: string | null, chunk: string[]): Promise<CandidateRow[]> {
	if (chunk.length === 0) return [];
	const corpus = concatText(sql`${messages.fromAddr}`, ",", sql`${messages.toAddr}`, ",", sql`coalesce(${messages.ccAddr}, '')`);
	const hit =
		schemaDialect() === "postgres"
			? sql`strpos(lower(${corpus}), lower(v.email)) > 0`
			: sql`instr(lower(${corpus}), lower(v.email)) > 0`;
	// Every delimiter a parsed address can border on becomes a comma, so
	// `,email,` in the normalized corpus means a complete address token — a
	// superset of what addressListIncludes will accept, cheap enough to rank by.
	const tokenCorpus = concatText(
		",",
		sql`replace(replace(replace(replace(replace(replace(replace(lower(${corpus}), ' ', ','), '<', ','), '>', ','), ';', ','), '"', ','), '(', ','), ')', ',')`,
		",",
	);
	const exactishHit =
		schemaDialect() === "postgres"
			? sql`strpos(${tokenCorpus}, ${concatText(",", sql`lower(v.email)`, ",")}) > 0`
			: sql`instr(${tokenCorpus}, ${concatText(",", sql`lower(v.email)`, ",")}) > 0`;
	const candidates = sql.join(
		chunk.map((email) => sql`select ${email} as email`),
		sql` union all `,
	);
	const contactJoin = ownerUserId === null ? sql`` : sql`left join ${contacts} on ${contacts.userId} = ${ownerUserId} and ${contacts.email} = v.email`;
	const storedEmail = ownerUserId === null ? sql`null` : sql`${contacts.email}`;
	const rows = await db.all(sql`
		select email, stored_email, from_addr, to_addr, cc_addr from (
			select v.email as email, ${storedEmail} as stored_email,
				${messages.fromAddr} as from_addr, ${messages.toAddr} as to_addr, ${messages.ccAddr} as cc_addr,
				row_number() over (partition by v.email order by case when ${exactishHit} then 0 else 1 end, ${messages.id}) as rn
			from (${candidates}) v
			join ${messages} on ${messages.mailboxId} = ${mailboxId} and ${draftsVisibleTo(viewerUserId)} and ${hit}
			${contactJoin}
		) ranked where ranked.rn <= ${sql.raw(String(VISIBILITY_ROWS_PER_CANDIDATE))}
	`);
	return (rows as Array<Record<string, unknown>>).map((row) => ({
		email: row.email as string,
		isContact: isExactStoredContact(row.stored_email as string | null, row.email as string),
		fromAddr: row.from_addr as string,
		toAddr: row.to_addr as string,
		ccAddr: row.cc_addr as string | null,
	}));
}

/** Rows where `email` appears as a real address in that same row's from/to/cc — the exact verdict, not the prefilter's. */
function candidateSeen(rows: CandidateRow[], seen: Set<string>, contacts?: Set<string>) {
	for (const row of rows) {
		if (row.isContact) contacts?.add(row.email);
		if ([row.fromAddr, row.toAddr, row.ccAddr].some((value) => addressListIncludes(value, row.email))) seen.add(row.email);
	}
}

/**
 * Contacts belong to the user who owns the mailbox, so a shared mailbox's contact list is its creator's whole
 * address book. Anyone who is not that owner may only see contacts whose address appears on mail in this mailbox.
 * Returns the subset of `emails` that does (exact address match).
 */
export async function addressesSeenInMailbox(db: Db, mailboxId: string, emails: string[], viewerUserId: string): Promise<Set<string>> {
	const seen = new Set<string>();
	const unique = [...new Set(emails)];
	for (let offset = 0; offset < unique.length; offset += VISIBILITY_CHUNK) {
		candidateSeen(await mailboxCandidateRows(db, mailboxId, viewerUserId, null, unique.slice(offset, offset + VISIBILITY_CHUNK)), seen);
	}
	return seen;
}

/**
 * The intersection of `emails`, the owner's stored contacts and the addresses
 * visible to `viewerUserId` on this mailbox's mail — what a delegated import
 * preview may call "existing". One stage: visibility and book membership are
 * computed by the same chunked scan, so a full 2000-candidate upload costs ~21
 * statements end to end, well under D1's per-invocation limit even with auth
 * and access reads counted.
 */
export async function existingContactsSeenInMailbox(db: Db, mailboxId: string, ownerUserId: string, emails: string[], viewerUserId: string): Promise<Set<string>> {
	const seen = new Set<string>();
	const stored = new Set<string>();
	const unique = [...new Set(emails)];
	for (let offset = 0; offset < unique.length; offset += VISIBILITY_CHUNK) {
		candidateSeen(await mailboxCandidateRows(db, mailboxId, viewerUserId, ownerUserId, unique.slice(offset, offset + VISIBILITY_CHUNK)), seen, stored);
	}
	stored.forEach((email) => {
		if (!seen.has(email)) stored.delete(email);
	});
	return stored;
}

export function toContactDetails(contact: Awaited<ReturnType<typeof getContactByEmail>>) {
	if (!contact) return null;
	const { avatarKey, ...details } = contact;
	return { ...details, hasAvatar: !!avatarKey };
}

export async function saveManualContact(
	db: Db,
	input: { userId: string; email: string; displayName?: string | null },
) {
	const existing = await getContactByEmail(db, input.userId, input.email);
	if (existing) {
		const displayName = input.displayName === undefined ? existing.displayName : input.displayName;
		await db
			.update(contacts)
			.set({ displayName, source: "manual" })
			.where(eq(contacts.id, existing.id));
		return { ...existing, displayName, source: "manual" as const };
	}

	const id = getContactId(input.userId, input.email);
	await db.insert(contacts).values({
		id,
		userId: input.userId,
		email: input.email,
		displayName: input.displayName ?? null,
		source: "manual",
	});
	return getContactByEmail(db, input.userId, input.email);
}
