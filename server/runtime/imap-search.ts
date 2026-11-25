/**
 * SEARCH criteria, parsed. This module is the IMAP half: it reads the search-key grammar (RFC 3501 §6.4.4)
 * into a tree, and the mailbox backend renders that tree as SQL (`imap-search-sql.ts`). Deliberately free of
 * database imports, so the protocol layer stays pure and every reply can be tested without one.
 *
 * The grammar is prefix and its arity is fixed: `OR` takes exactly two search-keys, `NOT` exactly one, and a
 * bare run of keys is an implicit AND (`search = "SEARCH" ... 1*(SP search-key)`). So there is no precedence to
 * climb: `OR NOT SEEN FLAGGED` is `OR (NOT SEEN) FLAGGED`, and `SUBJECT a OR FROM b TO c` is
 * `AND (SUBJECT a) (OR (FROM b) (TO c))`. Consequently `NOT A OR B` is not a query at all — `OR` is left with
 * one operand — and is refused rather than guessed at; a client means `OR NOT A B` or `NOT (A OR B)`. The infix
 * spelling (`SEEN OR FLAGGED`) is refused for the same reason: reading it as `OR SEEN FLAGGED` would make
 * `A B OR C` mean `A AND (B OR C)` or `A AND B AND (C ·)`, and a wrong answer is worse than a BAD.
 *
 * What is served, and what is refused, follows what the bridge can answer honestly:
 *
 * | Criterion                              | Answer                                                        |
 * | -------------------------------------- | ------------------------------------------------------------- |
 * | ALL                                    | every message in the selected mailbox                         |
 * | SEEN / UNSEEN                          | `read` (outbound mail is \Seen, as the UNSEEN counter counts) |
 * | FLAGGED / UNFLAGGED                    | `starred`                                                     |
 * | DELETED / UNDELETED                    | `trashed_at`                                                  |
 * | DRAFT / UNDRAFT                        | `status = 'draft'`                                            |
 * | SUBJECT, FROM, TO, CC, BCC <string>    | contains, on that column alone                                 |
 * | TEXT <string>                          | contains, over subject, the four address columns and the body |
 * | BODY <string>                          | contains, over the body columns alone                          |
 * | SINCE / BEFORE / ON <date>             | `created_at` (the internal date), as a UTC day                |
 * | SENTSINCE / SENTBEFORE / SENTON <date> | the same column: nothing stores a separate sent date          |
 * | <sequence set>                         | positional sequence numbers                                   |
 * | UID <set>                              | positional UIDs — in this bridge the same numbers             |
 * | NOT <key>, OR <key> <key>, (<keys>)    | the combinators, as written                                   |
 * | OLD                                    | every message: nothing carries \Recent                       |
 * | RECENT                                 | nothing: no \Recent tracking, and SELECT answers `0 RECENT`   |
 * | NEW                                    | nothing: RFC 3501 defines it as `RECENT UNSEEN`               |
 * | ANSWERED, UNANSWERED                   | BAD — no answered/replied state is stored                     |
 * | KEYWORD, UNKEYWORD                     | BAD — no keyword column exists                                |
 * | HEADER                                 | BAD — only the address/threading headers are columns          |
 * | LARGER, SMALLER                        | BAD — `messages` stores no size (the bytes live in the bucket) |
 *
 * `NEW` is the one adjudication worth stating: RFC 3501 §6.4.4 defines it as `(RECENT UNSEEN)`, and this
 * bridge reports no message as recent, so the consistent answer is the empty set. Aliasing it to UNSEEN would
 * make `SEARCH NEW` disagree with both `SEARCH RECENT` and the `0 RECENT` SELECT just answered, which is a
 * wrong answer where an empty one is merely a narrow one — a client that wants unread mail asks UNSEEN.
 *
 * Text matching is the REST search's own helper (`contains` in `src/lib/search/conditions.ts`): a NULL column
 * reads as empty text, the term is lower-cased and matched as a substring with `!` as the `LIKE` escape, and
 * SQLite folds ASCII only — the same trade-off every other search in the app makes. The bytes are decoded as
 * UTF-8 by the socket layer before they reach here, which is exactly why UTF-8 and US-ASCII are the two
 * charsets this command can honour.
 */

/** The flag criteria, folded onto the columns SELECT advertises (`\Seen \Flagged \Draft \Deleted`). */
export type ImapSearchFlag = "seen" | "unseen" | "flagged" | "unflagged" | "deleted" | "undeleted" | "draft" | "undraft";

/** The text criteria, each naming the columns it reads (`text` is the union, `body` the body columns only). */
export type ImapSearchTextField = "subject" | "from" | "to" | "cc" | "bcc" | "text" | "body";

/** The date criteria. The `sent*` forms read the internal date too; the table at the top says why. */
export type ImapSearchDateField = "since" | "before" | "on" | "sent-since" | "sent-before" | "sent-on";

/**
 * One parsed SEARCH key. `position` keeps the set as the client wrote it: `*` and the mailbox length are not
 * known to the parser, which is also why an out-of-range number is resolved to "no match" later rather than
 * refused here (RFC 3501 §6.4.4 allows a sequence set that names no message).
 */
export type ImapSearchCriteria =
	| { kind: "all" }
	/** A criterion this bridge answers with "nothing" rather than with a column: RECENT and NEW. */
	| { kind: "empty" }
	| { kind: "and"; criteria: ImapSearchCriteria[] }
	| { kind: "or"; left: ImapSearchCriteria; right: ImapSearchCriteria }
	| { kind: "not"; criteria: ImapSearchCriteria }
	| { kind: "flag"; flag: ImapSearchFlag }
	| { kind: "text"; field: ImapSearchTextField; value: string }
	/** `start` is midnight UTC of the date the client named, in milliseconds. */
	| { kind: "date"; field: ImapSearchDateField; start: number }
	/** A bare sequence set, or the argument of `UID`. */
	| { kind: "position"; set: string };

/** What `SEARCH`/`UID SEARCH` did with its arguments: a query, an unsupported charset (a NO), or a BAD. */
export type ImapSearchQuery =
	| { kind: "criteria"; criteria: ImapSearchCriteria }
	| { kind: "charset"; charset: string }
	| { kind: "error"; message: string };

/** The charsets whose bytes are already what the socket layer decoded: the criteria strings are UTF-8. */
export const IMAP_SEARCH_CHARSETS = ["UTF-8", "US-ASCII"] as const;
const SEARCH_CHARSETS = new Set<string>(IMAP_SEARCH_CHARSETS);

const TEXT_CRITERIA: Record<string, ImapSearchTextField> = {
	SUBJECT: "subject",
	FROM: "from",
	TO: "to",
	CC: "cc",
	BCC: "bcc",
	TEXT: "text",
	BODY: "body",
};

const DATE_CRITERIA: Record<string, ImapSearchDateField> = {
	SINCE: "since",
	BEFORE: "before",
	ON: "on",
	SENTSINCE: "sent-since",
	SENTBEFORE: "sent-before",
	SENTON: "sent-on",
};

const FLAG_CRITERIA: Record<string, ImapSearchFlag> = {
	SEEN: "seen",
	UNSEEN: "unseen",
	FLAGGED: "flagged",
	UNFLAGGED: "unflagged",
	DELETED: "deleted",
	UNDELETED: "undeleted",
	DRAFT: "draft",
	UNDRAFT: "undraft",
};

/**
 * Criteria that are legal IMAP and have no honest answer here. They are BAD with the reason, never silently
 * ignored: dropping a criterion turns it into "match everything", which is a wrong result the client cannot
 * tell from a right one.
 */
const UNSUPPORTED_CRITERIA: Record<string, string> = {
	ANSWERED: "no answered state is stored (\\Answered is not advertised)",
	UNANSWERED: "no answered state is stored (\\Answered is not advertised)",
	KEYWORD: "IMAP keywords are not stored",
	UNKEYWORD: "IMAP keywords are not stored",
	HEADER: "only the address and threading headers are stored as columns",
	LARGER: "no message size is stored (message bytes live in the object store)",
	SMALLER: "no message size is stored (message bytes live in the object store)",
	MODSEQ: "CONDSTORE is not advertised",
	REVERSE: "SORT and THREAD are not advertised",
};

const IMAP_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * One command's arguments. `CHARSET` is only meaningful in front (RFC 3501 §6.4.4), and it is refused after
 * the criteria parse, so a malformed query is BAD whichever charset it names; an unsupported charset is a NO
 * (with `[BADCHARSET]`), which is what the RFC asks for — the command was understood, its encoding was not.
 * Criteria strings are already decoded (the socket layer reads a literal as UTF-8), so UTF-8 and US-ASCII are
 * the two charsets this server can actually honour.
 */
export function parseImapSearchQuery(args: string[]): ImapSearchQuery {
	let charset: string | null = null;
	let rest = args;
	if (args[0]?.toUpperCase() === "CHARSET") {
		const name = args[1];
		if (!name || name === "(" || name === ")") return { kind: "error", message: "CHARSET needs a name" };
		charset = name.trim().toUpperCase();
		rest = args.slice(2);
	}
	if (rest.length === 0) return { kind: "error", message: "needs at least one criterion" };
	// The command line is split on spaces, so `(SEEN FLAGGED)` arrives as `(SEEN` and `FLAGGED)`; the cursor puts
	// those parens back where the IMAP grammar has them (see `splitParens`).
	const cursor = new SearchTokens(rest);
	const parsed = parseSequence(cursor, 0);
	if ("error" in parsed) return { kind: "error", message: parsed.error };
	// A stray `)` at the top level: parseSequence stops there, so anything left over is unparseable.
	const leftover = cursor.peek();
	if (leftover !== undefined) return { kind: "error", message: `unexpected ${echo(leftover)}` };
	if (charset !== null && !SEARCH_CHARSETS.has(charset)) return { kind: "charset", charset };
	const criteria = parsed.nodes.length === 1 ? parsed.nodes[0] : { kind: "and" as const, criteria: parsed.nodes };
	return { kind: "criteria", criteria };
}

/**
 * The argument list as a cursor, so a paren glued to a key can be split off that key and the pieces read in
 * order. Only a token in key position is split: the operand of a text criterion is taken whole, because a quoted
 * search string may legitimately contain parentheses (`SUBJECT "(draft)"`) and the tokenizer has already lost the
 * quoting that would tell the two apart. UID and the dates do split their operand, since a set or a date cannot
 * contain a paren.
 */
class SearchTokens {
	private index = 0;
	private readonly tokens: string[];

	constructor(tokens: string[]) {
		this.tokens = [...tokens];
	}

	peek(): string | undefined {
		return this.tokens[this.index];
	}

	take(): string | undefined {
		const token = this.tokens[this.index];
		if (token !== undefined) this.index += 1;
		return token;
	}

	/** Replace the token under the cursor with several, e.g. `(SUBJECT` with `(` and `SUBJECT`. */
	replace(...values: string[]): void {
		this.tokens.splice(this.index, 1, ...values);
	}

	/**
	 * A token in key position carrying parens: `(SUBJECT` opens a group and `FLAGGED))` closes two. Returns false
	 * with the parens split off, true when the token carries none.
	 */
	splitParens(): boolean {
		const token = this.peek();
		if (token === undefined) return true;
		if (token !== "(" && token.startsWith("(")) {
			this.replace("(", token.slice(1));
			return false;
		}
		const closers = token !== "(" && token !== ")" ? /(\)+)$/.exec(token)?.[1].length ?? 0 : 0;
		if (closers === 0) return true;
		return this.replaceTrailing(token, closers);
	}

	/** Move the `)`s off the end of a token (a key or a set/date operand) so each closes the group it belongs to. */
	replaceTrailing(token: string, closers: number): boolean {
		this.replace(token.slice(0, -closers), ...Array<string>(closers).fill(")"));
		return false;
	}

	/** The `)`s at the end of a token that is an operand no paren may be part of (a sequence set, a date). */
	takeWithoutClosers(): string | undefined {
		const token = this.peek();
		if (token === undefined) return undefined;
		const closers = /(\)+)$/.exec(token)?.[1].length ?? 0;
		if (closers > 0) this.replaceTrailing(token, closers);
		return this.take();
	}
}

type ParsedNodes = { nodes: ImapSearchCriteria[] };
type ParsedKey = { criteria: ImapSearchCriteria };

/**
 * A run of search-keys, which is an implicit AND: stops at `)` or the end of the argument list. `depth` is how
 * many groups are open, which is what tells a paren glued to the end of a value from a paren inside one.
 */
function parseSequence(cursor: SearchTokens, depth: number): ParsedNodes | { error: string } {
	const nodes: ImapSearchCriteria[] = [];
	while (cursor.peek() !== undefined && cursor.peek() !== ")") {
		const parsed = parseKey(cursor, depth);
		if ("error" in parsed) return parsed;
		nodes.push(parsed.criteria);
	}
	return { nodes };
}

/** One search-key. Fixed arity is what makes `NOT`/`OR` the prefix operators the RFC grammar describes. */
function parseKey(cursor: SearchTokens, depth: number): ParsedKey | { error: string } {
	if (cursor.peek() === undefined) return { error: "a criterion is missing" };
	// `(SUBJECT` and `FLAGGED)` carry their group's parens on the same token the command line produced.
	if (!cursor.splitParens()) return parseKey(cursor, depth);
	const token = cursor.peek()!;
	const upper = token.toUpperCase();
	if (token === "(") {
		cursor.take();
		const inner = parseSequence(cursor, depth + 1);
		if ("error" in inner) return inner;
		if (cursor.peek() !== ")") return { error: "parenthesized criteria are not closed" };
		cursor.take();
		if (inner.nodes.length === 0) return { error: "() holds no criterion" };
		return { criteria: inner.nodes.length === 1 ? inner.nodes[0] : { kind: "and", criteria: inner.nodes } };
	}
	if (token === ")") return { error: "unexpected )" };
	cursor.take();
	if (upper === "NOT") {
		if (cursor.peek() === undefined) return { error: "NOT needs one criterion" };
		const operand = parseKey(cursor, depth);
		if ("error" in operand) return operand;
		return { criteria: { kind: "not", criteria: operand.criteria } };
	}
	if (upper === "OR") {
		if (cursor.peek() === undefined || cursor.peek() === ")") return { error: "OR needs two criteria" };
		const left = parseKey(cursor, depth);
		if ("error" in left) return left;
		if (cursor.peek() === undefined || cursor.peek() === ")") return { error: "OR needs two criteria" };
		const right = parseKey(cursor, depth);
		if ("error" in right) return right;
		return { criteria: { kind: "or", left: left.criteria, right: right.criteria } };
	}
	if (upper === "ALL") return { criteria: { kind: "all" } };
	const flag = FLAG_CRITERIA[upper];
	if (flag) return { criteria: { kind: "flag", flag } };
	// RECENT is empty because nothing is recent; OLD is its complement, so it is every message.
	if (upper === "RECENT" || upper === "NEW") return { criteria: { kind: "empty" } };
	if (upper === "OLD") return { criteria: { kind: "all" } };
	const unsupported = UNSUPPORTED_CRITERIA[upper];
	if (unsupported) return { error: `${upper} is not supported: ${unsupported}` };
	const text = TEXT_CRITERIA[upper];
	if (text) {
		// The value is verbatim, because a search string may itself be `(something)` — unless a group is open and
		// the token also carries that group's closing paren, as `FROM shop.test)` does when the command line was
		// split on spaces. A quoted value that legitimately ends with `)` inside a group is refused (it leaves a
		// paren unclosed) rather than silently searched as something shorter.
		const value = cursor.peek() === "(" || cursor.peek() === ")" ? undefined : depth > 0 ? cursor.takeWithoutClosers() : cursor.take();
		if (value === undefined || value === "(" || value === ")") return { error: `${upper} needs a string` };
		return { criteria: { kind: "text", field: text, value } };
	}
	const date = DATE_CRITERIA[upper];
	if (date) {
		const value = cursor.peek() === "(" || cursor.peek() === ")" ? undefined : cursor.takeWithoutClosers();
		if (value === undefined) return { error: `${upper} needs a date` };
		const start = parseImapSearchDate(value);
		if (start === null) return { error: `${upper} date ${echo(value)} is not DD-Mon-YYYY` };
		return { criteria: { kind: "date", field: date, start } };
	}
	if (upper === "UID") {
		const set = cursor.peek() === "(" || cursor.peek() === ")" ? undefined : cursor.takeWithoutClosers();
		// A `UID` that names no set is malformed; a set that names no existing message is just an empty result.
		if (set === undefined || !isImapSetSyntax(set)) return { error: "UID needs a message set" };
		return { criteria: { kind: "position", set } };
	}
	// An unlabelled sequence set is the sequence-number criterion (RFC 3501 §6.4.4).
	if (isImapSetSyntax(token)) return { criteria: { kind: "position", set: token } };
	return { error: `${echo(token)} is not a supported criterion` };
}

/**
 * RFC 3501 §9 `date` (`DD-Mon-YYYY`), which is a calendar day rather than a timestamp: the day boundaries are
 * UTC, the same interpretation the rest of the app gives a bare date. A day that does not exist is refused
 * instead of being rolled over into the next month.
 */
export function parseImapSearchDate(value: string): number | null {
	const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
	if (!match) return null;
	const month = IMAP_MONTHS.indexOf(match[2].toLowerCase());
	if (month < 0) return null;
	const day = Number(match[1]);
	const year = Number(match[3]);
	const start = Date.UTC(year, month, day);
	const date = new Date(start);
	if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
	return start;
}

/** `n`, `n:m`, `n:*`, `*`, comma-separated — the syntax a sequence set has to have before it can be resolved. */
export function isImapSetSyntax(value: string): boolean {
	const point = "(?:\\*|\\d+)";
	return new RegExp(`^${point}(?::${point})?(?:,${point}(?::${point})?)*$`).test(value);
}

/**
 * Resolve a sequence set against a mailbox of `last` messages. Unlike FETCH's set parser this one does not
 * refuse an out-of-range number: a set that names no message matches nothing (RFC 3501 §6.4.4), and a client
 * searching for a UID it has not seen yet must get an empty answer rather than an error. `*` is the last
 * message, and a reversed range means the same two ends.
 */
export function resolveImapSet(value: string, last: number): number[] {
	if (!isImapSetSyntax(value)) return [];
	const wanted = new Set<number>();
	for (const part of value.split(",")) {
		const [left, right] = part.split(":");
		const from = left === "*" ? last : Number(left);
		const to = right === undefined ? from : right === "*" ? last : Number(right);
		const first = Math.min(from, to);
		const end = Math.max(from, to);
		for (let number = Math.max(1, first); number <= Math.min(last, end); number++) wanted.add(number);
	}
	return [...wanted].sort((a, b) => a - b);
}

/**
 * Echo a client-supplied token back inside a BAD: printable ASCII only and bounded, so nothing a client sends
 * can reach the reply as a control character or an unbounded line.
 */
function echo(token: string): string {
	const printable = token.replace(/[^\x20-\x7e]/g, "?");
	return printable.length > 40 ? `${printable.slice(0, 40)}...` : printable;
}
