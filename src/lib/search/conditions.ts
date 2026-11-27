import { and, eq, exists, gte, isNull, lt, ne, not, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { schemaDialect } from "@/db/dialect";
import {
	buildBooleanFreeTextMatch,
	buildBooleanNegation,
	buildFtsColumnMatch,
	buildFtsFreeTextMatch,
	buildFtsNegation,
	buildTsQueryFreeTextMatch,
	buildTsQueryNegation,
	parseSearchQuery,
	tokenizeSearchText,
} from "./query-utils";
import type { ParsedSearchQuery } from "./types";

/** `!` is the escape character because it needs no escaping itself in either SQL string syntax. */
const likePattern = (term: string) => `%${term.toLowerCase().replace(/[!%_]/g, "!$&")}%`;
/** A NULL column counts as empty text: otherwise `NOT (a OR b)` is NULL and a negated term hides the row. */
const contains = (column: SQL | AnyColumn, term: string) => sql`coalesce(lower(${column}), '') like ${likePattern(term)} escape '!'`;

/**
 * Text search for databases without FTS5 (PostgreSQL, MySQL): every term must appear as a substring of the
 * subject, an address or the body. It scans the mailbox's messages instead of using an index, which is the
 * documented trade-off of those dialects for the message's own columns.
 *
 * The attachment half of a free-text search does use an index here (F53): PostgreSQL keeps a partial GIN
 * index over a `to_tsvector` expression on the eligible rows and MySQL a FULLTEXT index on the column —
 * both named `message_attachments_extracted_text_fts_idx` and both scoped to the same `extract_status =
 * 'done' AND extracted_text IS NOT NULL` set the SQLite FTS5 table holds (MySQL indexes every row and the
 * predicate is enforced in the WHERE instead — there are no partial indexes). The shape is the FTS5 one:
 * every positive term has to appear in the message or in one same attachment (the union), and a negated
 * term is rejected against both — a hit on one side never excuses a NOT on the other.
 */
function buildLikeConditions(parsed: ParsedSearchQuery, attachmentText: boolean): SQL[] {
	const conditions: SQL[] = [];
	const positives: SQL[] = [];
	for (const token of tokenizeSearchText(parsed.text)) {
		const match = or(
			contains(messages.subject, token.term),
			contains(messages.fromAddr, token.term),
			contains(messages.toAddr, token.term),
			contains(messages.ccAddr, token.term),
			contains(messages.textBody, token.term),
			and(sql`${messages.textBody} is null`, contains(messages.htmlBody, token.term)),
		)!;
		if (token.negate) conditions.push(not(match));
		else positives.push(match);
	}
	// The dialect's attachment index answers an expression built from the same tokens the LIKE clauses
	// use: a `to_tsquery` input on PostgreSQL, a boolean-mode AGAINST string on MySQL. Either way the
	// expression stays a bound parameter — the token words carry no operators (see query-utils.ts).
	const postgres = schemaDialect() === "postgres";
	const attachmentMatches = (expr: string) =>
		sql`${messages}.id IN (SELECT ${messageAttachments.messageId} FROM ${messageAttachments} WHERE ${messageAttachments.extractStatus} = 'done' AND ${messageAttachments.extractedText} IS NOT NULL AND ${postgres
			? sql`to_tsvector('simple', ${messageAttachments.extractedText}) @@ to_tsquery('simple', ${expr})`
			: sql`MATCH(${messageAttachments.extractedText}) AGAINST(${expr} IN BOOLEAN MODE)`})`;
	const freeText = postgres ? buildTsQueryFreeTextMatch(parsed) : buildBooleanFreeTextMatch(parsed);
	if (attachmentText && freeText) conditions.push(or(and(...positives), attachmentMatches(freeText))!);
	else conditions.push(...positives);
	const negation = postgres ? buildTsQueryNegation(parsed) : buildBooleanNegation(parsed);
	if (attachmentText && negation) conditions.push(not(attachmentMatches(negation)));
	const column = (columns: Array<SQL | AnyColumn>, value: string | undefined) => {
		if (!value) return;
		for (const token of tokenizeSearchText(value)) conditions.push(or(...columns.map((c) => contains(c, token.term)))!);
	};
	column([messages.subject], parsed.subject);
	column([messages.fromAddr], parsed.from);
	column([messages.toAddr, messages.ccAddr], parsed.to);
	return conditions;
}

export type SearchConditionOptions = {
	/** Whether the dialect's attachment-text index exists; see `hasAttachmentSearchIndex` in ./attachment-index. */
	attachmentText?: boolean;
};

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
 * to be from maya and finds "invoice" in its body or in one of its attachments.
 *
 * A negated term has to hold for the whole message, so it is applied outside the OR:
 * the message is rejected if `messages_fts` matches it *or* if one of its attachments
 * does. Folding it into the positive expression would let an attachment hit satisfy
 * the `NOT` that the message index rejected (`invoice -confidential` returned a
 * message whose body says confidential, F52 gate).
 *
 * Two things to know about that text. It exists only for rows the extraction
 * sweep has reached: a row still at `extract_status = 'none'` is invisible to
 * search until then (see src/lib/email/attachment-sweep.ts). And the attachment
 * half of the union exists on every dialect (F53): PostgreSQL and MySQL keep
 * message columns on the LIKE scan but match attachment text through their own
 * indexes with the same union/negation split — see buildLikeConditions.
 *
 * `attachments_fts` is checked first: the Worker is deployed before its migrations are
 * applied (docs/deployment.md), so a SQLite database can be one release behind the code,
 * and naming a table that does not exist fails the whole statement — `no such table`
 * turns every free-text search, message-only ones included, into a 500. With
 * `attachmentText: false` the query is exactly the pre-F52 message-only search.
 */
export function buildSearchConditions(raw: string, timeZone = "UTC", options: SearchConditionOptions = {}): SQL[] {
	const parsed = parseSearchQuery(raw, timeZone);
	const conditions: SQL[] = [];

	if (schemaDialect() === "sqlite") {
		const attachmentText = options.attachmentText === true;
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
		if (freeText) {
			conditions.push(attachmentText ? or(inMessages(freeText), attachmentMatches(freeText))! : inMessages(freeText));
		}
		// Negations are not part of that union: they have to hold in both indexes.
		const negation = buildFtsNegation(parsed);
		if (negation) {
			conditions.push(notInMessages(negation));
			if (attachmentText) conditions.push(attachmentMisses(negation));
		}
	} else {
		conditions.push(...buildLikeConditions(parsed, options.attachmentText === true));
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
