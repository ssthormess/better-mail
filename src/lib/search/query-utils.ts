import type { ParsedSearchQuery, SearchToken } from "./types";
import { dateFromZonedFields, normalizeTimeZone } from "@/lib/time/utils";
import { normalizeSearchText } from "./normalize";

/**
 * Gmail-style search grammar shared by the search box and the API:
 *
 *   from:maya to:"sam okoro" subject:invoice has:attachment is:unread
 *   is:starred after:2026-09-01 before:2026-09-30 "exact phrase" -excluded word
 *
 * The older `title:` and bare `:unread` / `:read` forms keep working.
 */
const OPERATOR_RE = /(?:^|\s)(from|to|subject|title|has|is|after|before|newer|older|category):(?:"([^"]*)"|(\S+))/gi;

export function parseSearchQuery(raw: string, timeZone = "UTC"): ParsedSearchQuery {
	const parsed: ParsedSearchQuery = { text: "", needsFullText: false };
	let rest = raw ?? "";

	rest = rest.replace(OPERATOR_RE, (match, key: string, quoted: string | undefined, bare: string | undefined) => {
		const value = (quoted ?? bare ?? "").trim();
		switch (key.toLowerCase()) {
			case "from":
				parsed.from = value;
				break;
			case "to":
				parsed.to = value;
				break;
			case "subject":
			case "title":
				parsed.subject = value;
				break;
			case "has":
				if (/^attachments?$/i.test(value)) parsed.hasAttachment = true;
				break;
			case "is":
				if (/^unread$/i.test(value)) parsed.read = "unread";
				else if (/^read$/i.test(value)) parsed.read = "read";
				else if (/^starred$/i.test(value)) parsed.starred = true;
				break;
			case "category":
				if (/^promotions?$/i.test(value)) parsed.category = "promotions";
				else if (/^(primary|inbox)$/i.test(value)) parsed.category = "primary";
				else return match; // an unknown value stays free text
				break;
			case "after":
			case "newer":
				parsed.after = parseDate(value, timeZone) ?? parsed.after;
				break;
			case "before":
			case "older":
				parsed.before = parseDate(value, timeZone) ?? parsed.before;
				break;
		}
		return " ";
	});

	if (/(^|\s):unread(?=\s|$)/i.test(rest)) {
		parsed.read = "unread";
		rest = rest.replace(/(^|\s):unread(?=\s|$)/gi, " ");
	} else if (/(^|\s):read(?=\s|$)/i.test(rest)) {
		parsed.read = "read";
		rest = rest.replace(/(^|\s):read(?=\s|$)/gi, " ");
	}

	parsed.text = rest.replace(/\s+/g, " ").trim();
	parsed.needsFullText = !!(parsed.text || parsed.from || parsed.to || parsed.subject);
	return parsed;
}

function parseDate(value: string, timeZone: string): Date | undefined {
	const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (!match) return undefined;
	const date = new Date(0);
	date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return undefined;
	return dateFromZonedFields(date, normalizeTimeZone(timeZone));
}

/** Split free text into phrases ("..."), negations (-word) and plain terms. */
export function tokenizeSearchText(text: string): SearchToken[] {
	const tokens: SearchToken[] = [];
	const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		if (match[2] !== undefined) {
			const term = match[2].trim();
			if (term) tokens.push({ term, negate: match[1] === "-", phrase: true });
		} else {
			const term = match[4].replace(/^-+/, "").trim();
			if (term) tokens.push({ term, negate: match[3] === "-", phrase: false });
		}
	}
	return tokens;
}

/** FTS5 string literal: double quotes doubled, so user input can never alter the query grammar. */
function ftsString(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The words a search term is allowed to contribute, in every dialect. Punctuation the
 * tokenizers treat as separators is normalised to spaces first, so "maya@acme.test"
 * becomes the words "maya acme test". Whatever remains is letters, digits and spaces —
 * nothing that could change the grammar of the expression it is rendered into, which is
 * what keeps the tsquery and boolean-mode strings below safe to build.
 */
function cleanTermWords(term: string): string {
	return term.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * The words a term contributes to an attachment-text index expression (F53 r2):
 * the shared normalizer of ./normalize.ts, so a query asks every dialect for
 * the same tokens its index was fed. Unlike cleanTermWords this also folds
 * accents and drops unindexable tokens (short words, stopwords), which is why a
 * term can legitimately clean to "" here — the clause it would have built is
 * then simply absent, on every dialect alike.
 */
function cleanAttachmentWords(term: string): string {
	return normalizeSearchText(term);
}

/** Turns a term into its indexable words; per index, not per term — see the two above. */
type TermCleaner = (term: string) => string;

/**
 * One term as an FTS5 expression. Phrases match whole words; plain terms match by prefix
 * so "inv" finds "invoice". A term that cleans to several words is matched as a phrase.
 */
function ftsTerm(term: string, phrase: boolean, clean: TermCleaner = cleanTermWords): string {
	const cleaned = clean(term);
	if (!cleaned) return "";
	if (phrase || cleaned.includes(" ")) {
		// A multi-word prefix query needs the last word starred, which FTS5 only
		// allows inside a phrase as `"a b" *`; keep it simple and require whole words.
		return ftsString(cleaned);
	}
	return `${ftsString(cleaned)}*`;
}

/**
 * One term as a `to_tsquery` operand (PostgreSQL, F53): `word:*` keeps FTS5's prefix
 * matching and `w1 <-> w2` is the adjacent-words phrase. Parenthesised so a phrase can
 * sit inside a `&` or `|` expression without depending on operator precedence. The words
 * carry no operators — cleanTermWords already removed them — so the composed string is
 * still a plain parameter of `to_tsquery`, never interpolated SQL.
 */
function tsQueryTerm(term: string, phrase: boolean, clean: TermCleaner): string {
	const cleaned = clean(term);
	if (!cleaned) return "";
	if (phrase || cleaned.includes(" ")) return `(${cleaned.split(" ").join(" <-> ")})`;
	return `${cleaned}:*`;
}

/**
 * One term as a MySQL boolean-mode AGAINST word (F53): `word*` is the prefix form FTS5
 * uses and `"w1 w2"` the phrase. The leading `+` of an ANDed positive is added by the
 * combiner, not here, so the same term works inside the ORed negation.
 */
function booleanTerm(term: string, phrase: boolean, clean: TermCleaner): string {
	const cleaned = clean(term);
	if (!cleaned) return "";
	if (phrase || cleaned.includes(" ")) return `"${cleaned}"`;
	return `${cleaned}*`;
}

/** Free-text terms rendered by `render`, kept apart so negations can be applied separately. */
function textParts(
	text: string,
	render: (term: string, phrase: boolean, clean: TermCleaner) => string,
	clean: TermCleaner = cleanTermWords,
): { positives: string[]; negatives: string[] } {
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const token of tokenizeSearchText(text)) {
		const expr = render(token.term, token.phrase, clean);
		if (!expr) continue;
		(token.negate ? negatives : positives).push(expr);
	}
	return { positives, negatives };
}

/** Free-text terms as FTS5 expressions, kept apart so negations can be applied separately. */
function ftsTextParts(text: string): { positives: string[]; negatives: string[] } {
	return textParts(text, ftsTerm);
}

/** FTS5 has no unary NOT, so a MATCH made only of negations is a syntax error; negations are a separate expression. */
function combined(expressions: string[], operator: "AND" | "OR"): string | null {
	return expressions.length > 0 ? expressions.join(` ${operator} `) : null;
}

/** Column filters as FTS5 expressions (`subject : (...) AND from_addr : (...)`), in query order. */
function ftsColumnParts(parsed: ParsedSearchQuery): string[] {
	const parts: string[] = [];
	const column = (name: string, value: string | undefined) => {
		if (!value) return;
		const terms = tokenizeSearchText(value)
			.map((token) => ftsTerm(token.term, token.phrase))
			.filter(Boolean);
		if (terms.length === 0) return;
		parts.push(`${name} : (${terms.join(" AND ")})`);
	};
	column("subject", parsed.subject);
	column("from_addr", parsed.from);
	column("{to_addr cc_addr}", parsed.to);
	return parts;
}

/**
 * The column-filter half of a query (`subject : (…) AND from_addr : (…)`), on its own.
 * A second index that has no columns of its own still has to be scoped by the message's
 * columns, which is what this expression is for: it is always required, while free text
 * may be satisfied by the message or by one of its attachments (attachment text, F52).
 *
 * The three expressions below are what a search turns into. FTS5 has no unary NOT and a
 * MATCH made only of negations is a syntax error, so negations are never folded into the
 * positive expression: a caller matches `buildFtsColumnMatch` + `buildFtsFreeTextMatch`
 * and separately rejects `buildFtsNegation` with a `NOT IN` subquery, against every index
 * whose rows can satisfy the search. Each is null when there is nothing of that kind.
 */
export function buildFtsColumnMatch(parsed: ParsedSearchQuery): string | null {
	return combined(ftsColumnParts(parsed), "AND");
}

/**
 * The negated free-text terms as one expression (`"a"* OR "b"*`), or null when the
 * query negates nothing. The caller rejects it against every index, not only the one
 * that names the message: a negated term must not be excused by a hit in another
 * source (F52 gate, `invoice -confidential`).
 */
export function buildFtsNegation(parsed: ParsedSearchQuery): string | null {
	const { negatives } = ftsTextParts(parsed.text);
	return combined(negatives, "OR");
}

/**
 * The positive free-text terms without the column filters, for an index that has no
 * subject, sender or recipient of its own (attachment text, F52). It is ORed with the
 * message match, so a query whose only terms are column filters returns null and
 * searches no attachment text.
 *
 * Negations are deliberately absent here too: an attachment hit could otherwise
 * satisfy the positive side of a `NOT` the message index had rejected.
 */
export function buildFtsFreeTextMatch(parsed: ParsedSearchQuery): string | null {
	const { positives } = ftsTextParts(parsed.text);
	return combined(positives, "AND");
}

/**
 * The `buildAttachment*` functions below build the free-text expressions for the
 * attachment-text index of each dialect (F53), all through the shared normalizer
 * (cleanAttachmentWords): whatever the engines' tokenizers could disagree on —
 * accents, punctuation inside a word, sub-three-character or stopword tokens —
 * never reaches them, so every dialect answers the same term the same way.
 * A term that normalizes to nothing contributes no clause, which is what makes a
 * negated unindexable term permissive-equal across dialects instead of silently
 * under-excluding on one of them (F53 gate round 1: `quick -the` on MySQL).
 *
 * The message index keeps its own semantics (buildFts* above): messages_fts and
 * the LIKE scan still see the raw term, including words the attachment index
 * never stores.
 */

/** Positive free text for `attachments_fts` (SQLite): `"a"* AND "b c"`, mirroring buildFtsFreeTextMatch. */
export function buildAttachmentFtsMatch(parsed: ParsedSearchQuery): string | null {
	const { positives } = textParts(parsed.text, ftsTerm, cleanAttachmentWords);
	return combined(positives, "AND");
}

/** Negated terms for `attachments_fts` (`"a"* OR "b c"`), mirroring buildFtsNegation. */
export function buildAttachmentFtsNegation(parsed: ParsedSearchQuery): string | null {
	const { negatives } = textParts(parsed.text, ftsTerm, cleanAttachmentWords);
	return combined(negatives, "OR");
}

/**
 * The positive free-text terms as one `to_tsquery` input (PostgreSQL, F53):
 * `a:* & (b <-> c)` — every term required, like the ANDed FTS5 expression, and with
 * FTS5's prefix and phrase semantics. Feeding `to_tsquery` rather than `plainto_tsquery`
 * is deliberate: it is the only parser that keeps `:*` prefixing, and the string handed
 * to it contains nothing but cleaned words and the operators built here.
 */
export function buildAttachmentTsQueryMatch(parsed: ParsedSearchQuery): string | null {
	const { positives } = textParts(parsed.text, tsQueryTerm, cleanAttachmentWords);
	return positives.length > 0 ? positives.join(" & ") : null;
}

/** The negated terms as one `to_tsquery` input (`a:* | b:*`), mirroring buildAttachmentFtsNegation. */
export function buildAttachmentTsQueryNegation(parsed: ParsedSearchQuery): string | null {
	const { negatives } = textParts(parsed.text, tsQueryTerm, cleanAttachmentWords);
	return negatives.length > 0 ? negatives.join(" | ") : null;
}

/**
 * The positive terms as a MySQL boolean-mode AGAINST string (F53): `+a* +"b c"` — `+`
 * makes each term required, the `*` suffix the prefix match and quoting the phrase, the
 * same three shapes the tsquery and FTS5 expressions use.
 */
export function buildAttachmentBooleanMatch(parsed: ParsedSearchQuery): string | null {
	const { positives } = textParts(parsed.text, booleanTerm, cleanAttachmentWords);
	return positives.length > 0 ? positives.map((expr) => `+${expr}`).join(" ") : null;
}

/**
 * The negated terms as a MySQL boolean-mode AGAINST string (`a* "b c"`): with no `+`
 * a row that mentions any negated term scores, and the caller excludes it with NOT IN,
 * matching buildAttachmentFtsNegation. Bare terms are used instead of the `-` operator
 * because a query that is all `-` words matches nothing in boolean mode.
 */
export function buildAttachmentBooleanNegation(parsed: ParsedSearchQuery): string | null {
	const { negatives } = textParts(parsed.text, booleanTerm, cleanAttachmentWords);
	return negatives.length > 0 ? negatives.join(" ") : null;
}
