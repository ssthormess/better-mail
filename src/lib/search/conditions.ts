import { and, eq, exists, gte, isNull, lt, ne, not, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { schemaDialect } from "@/db/dialect";
import { buildFtsColumnMatch, buildFtsFreeTextMatch, buildFtsNegation, parseSearchQuery, tokenizeSearchText } from "./query-utils";
import type { ParsedSearchQuery } from "./types";

/** `!` is the escape character because it needs no escaping itself in either SQL string syntax. */
const likePattern = (term: string) => `%${term.toLowerCase().replace(/[!%_]/g, "!$&")}%`;
/** A NULL column counts as empty text: otherwise `NOT (a OR b)` is NULL and a negated term hides the row. */
const contains = (column: SQL | AnyColumn, term: string) => sql`coalesce(lower(${column}), '') like ${likePattern(term)} escape '!'`;

/**
 * Text search for databases without FTS5 (PostgreSQL, MySQL): every term must appear as a substring of the
 * subject, an address or the body. It scans the mailbox's messages instead of using an index, which is the
 * documented trade-off of those dialects.
 */
function buildLikeConditions(parsed: ParsedSearchQuery): SQL[] {
	const conditions: SQL[] = [];
	for (const token of tokenizeSearchText(parsed.text)) {
		const match = or(
			contains(messages.subject, token.term),
			contains(messages.fromAddr, token.term),
			contains(messages.toAddr, token.term),
			contains(messages.ccAddr, token.term),
			contains(messages.textBody, token.term),
			and(sql`${messages.textBody} is null`, contains(messages.htmlBody, token.term)),
		)!;
		conditions.push(token.negate ? not(match) : match);
	}
	const column = (columns: Array<SQL | AnyColumn>, value: string | undefined) => {
		if (!value) return;
		for (const token of tokenizeSearchText(value)) conditions.push(or(...columns.map((c) => contains(c, token.term)))!);
	};
	column([messages.subject], parsed.subject);
	column([messages.fromAddr], parsed.from);
	column([messages.toAddr, messages.ccAddr], parsed.to);
	return conditions;
}

/**
 * Translate a search string into WHERE conditions on `messages`. Text goes to
 * the FTS5 index by rowid; everything else is a plain column predicate, so the
 * caller ANDs these with its own scope (mailbox access, folder, status).
 *
 * On SQLite, attachment text is part of a general text search (F52): the free
 * text of the query also matches `attachments_fts`, so a message is a hit when
 * either it or one of its attachments contains the terms. The scope is the whole
 * free-text search, not just `has:attachment` queries — the same query that finds
 * a word in a body finds it in an attachment's extracted text.
 *
 * Column filters stay message conditions: `from:maya invoice` requires the message
 * to be from maya and finds "invoice" in its body or in one of its attachments. A
 * negation must hold everywhere, so `-revenue` also rejects a message whose
 * attachment mentions it.
 *
 * Two things to know about that text. It exists only for rows the extraction
 * sweep has reached: a row still at `extract_status = 'none'` is invisible to
 * search until then (see src/lib/email/attachment-sweep.ts). And none of this runs
 * on PostgreSQL or MySQL, where the branch below stays the LIKE scan it always
 * was; those dialects get attachment parity in F53.
 */
export function buildSearchConditions(raw: string, timeZone = "UTC"): SQL[] {
	const parsed = parseSearchQuery(raw, timeZone);
	const conditions: SQL[] = [];

	if (schemaDialect() === "sqlite") {
		const inMessages = (expression: string) =>
			sql`${messages}.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${expression})`;
		const notInMessages = (expression: string) =>
			sql`${messages}.rowid NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${expression})`;
		// `message_attachments.rowid` is the docid of `attachments_fts`, so the index
		// names attachments and the subquery maps them back to their message.
		const attachmentMatches = (expression: string) => sql`${messages}.id IN (SELECT ${messageAttachments.messageId} FROM ${messageAttachments} WHERE ${messageAttachments}.rowid IN (SELECT rowid FROM attachments_fts WHERE attachments_fts MATCH ${expression}))`;
		const attachmentMisses = (expression: string) => sql`${messages}.id NOT IN (SELECT ${messageAttachments.messageId} FROM ${messageAttachments} WHERE ${messageAttachments}.rowid IN (SELECT rowid FROM attachments_fts WHERE attachments_fts MATCH ${expression}))`;

		// subject:/from:/to: filter the message itself; it is never satisfied by an attachment.
		const columns = buildFtsColumnMatch(parsed);
		if (columns) conditions.push(inMessages(columns));

		// Free text may be in the message or in one of its attachments, but every
		// positive term has to appear in that same row of either index.
		const freeText = buildFtsFreeTextMatch(parsed);
		if (freeText.match) {
			conditions.push(or(inMessages(freeText.match), attachmentMatches(freeText.match))!);
		} else if (freeText.exclude) {
			conditions.push(notInMessages(freeText.exclude));
		}
		// A negated term is excluded wherever it appears, so it cannot be folded into
		// the union above: the message must have no attachment matching it either.
		const negation = buildFtsNegation(parsed);
		if (negation) conditions.push(attachmentMisses(negation));
	} else {
		conditions.push(...buildLikeConditions(parsed));
	}
	if (parsed.hasAttachment) {
		conditions.push(
			exists(
				sql`(SELECT 1 FROM ${messageAttachments} WHERE ${messageAttachments.messageId} = ${messages.id} AND ${messageAttachments.disposition} = 'attachment')`,
			),
		);
	}
	if (parsed.read === "read") conditions.push(eq(messages.read, true));
	if (parsed.read === "unread") conditions.push(eq(messages.read, false));
	if (parsed.starred) conditions.push(eq(messages.starred, true));
	if (parsed.category === "promotions") conditions.push(eq(messages.category, "promotions"));
	if (parsed.category === "primary") conditions.push(or(isNull(messages.category), ne(messages.category, "promotions"))!);
	if (parsed.after) conditions.push(gte(messages.createdAt, parsed.after));
	if (parsed.before) conditions.push(lt(messages.createdAt, parsed.before));

	return conditions.length ? [and(...conditions)!] : [];
}
