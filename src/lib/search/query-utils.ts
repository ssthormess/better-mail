import type { ParsedSearchQuery, SearchToken } from "./types";
import { dateFromZonedFields, normalizeTimeZone } from "@/lib/time/utils";

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
 * One term. Phrases match whole words; plain terms match by prefix so "inv"
 * finds "invoice". Punctuation FTS5 treats as separators is normalised to
 * spaces first, so "maya@acme.test" becomes the phrase "maya acme test".
 */
function ftsTerm(term: string, phrase: boolean): string {
	const cleaned = term.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	if (phrase || cleaned.includes(" ")) {
		// A multi-word prefix query needs the last word starred, which FTS5 only
		// allows inside a phrase as `"a b" *`; keep it simple and require whole words.
		return ftsString(cleaned);
	}
	return `${ftsString(cleaned)}*`;
}

/** Free-text terms as FTS5 expressions, kept apart so negations can be applied separately. */
function ftsTextParts(text: string): { positives: string[]; negatives: string[] } {
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const token of tokenizeSearchText(text)) {
		const expr = ftsTerm(token.term, token.phrase);
		if (!expr) continue;
		(token.negate ? negatives : positives).push(expr);
	}
	return { positives, negatives };
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
