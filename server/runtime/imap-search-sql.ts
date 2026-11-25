import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, not, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messages } from "@/db/schema";
import { matchEverything, matchNothing } from "@/db/sql";
import { contains } from "@/lib/search/conditions";
import { resolveImapSet, type ImapSearchCriteria, type ImapSearchDateField, type ImapSearchFlag, type ImapSearchTextField } from "./imap-search";

/** One UTC day in milliseconds: ON/SENTON are a half-open day range, not an instant comparison. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The flag criteria, on the same columns SELECT and FETCH report them from. Outbound mail is `\Seen` because it
 * has no read toggle and the UNSEEN counter does not count it either, so `SEEN`/`UNSEEN` agree with FETCH FLAGS
 * for every message. Every predicate here reads a NOT NULL column, which is what lets `NOT` be applied to the
 * tree without a three-valued twist.
 */
const FLAG_CONDITIONS: Record<ImapSearchFlag, () => SQL> = {
	seen: () => or(eq(messages.read, true), eq(messages.direction, "outbound"))!,
	unseen: () => and(eq(messages.read, false), eq(messages.direction, "inbound"))!,
	flagged: () => eq(messages.starred, true),
	unflagged: () => eq(messages.starred, false),
	deleted: () => isNotNull(messages.trashedAt),
	undeleted: () => isNull(messages.trashedAt),
	draft: () => eq(messages.status, "draft"),
	undraft: () => ne(messages.status, "draft"),
};

/**
 * The body predicate: both body columns, so a term that only exists in the HTML alternative of a multipart
 * message still matches. The REST search's `buildLikeConditions` consults `html_body` only when `text_body` is
 * absent; here BODY means the body of the message as a client sees it, and the two columns are the two ways this
 * bridge stores that body, so both are read.
 */
function bodyCondition(term: string): SQL {
	return or(contains(messages.textBody, term), contains(messages.htmlBody, term))!;
}

/**
 * The text criteria. `TEXT` is RFC 3501's "header or body", which here is every text column the bridge stores —
 * the subject, the four address columns (Bcc included) and the body. Each is a NULL-safe case-insensitive
 * substring match, so a message with no Cc column can still satisfy `NOT CC x`.
 */
const TEXT_CONDITIONS: Record<ImapSearchTextField, (term: string) => SQL> = {
	subject: (term) => contains(messages.subject, term),
	from: (term) => contains(messages.fromAddr, term),
	to: (term) => contains(messages.toAddr, term),
	cc: (term) => contains(messages.ccAddr, term),
	bcc: (term) => contains(messages.bccAddr, term),
	body: bodyCondition,
	text: (term) =>
		or(
			contains(messages.subject, term),
			contains(messages.fromAddr, term),
			contains(messages.toAddr, term),
			contains(messages.ccAddr, term),
			contains(messages.bccAddr, term),
			bodyCondition(term),
		)!,
};

/**
 * The date criteria, all on `created_at` — the internal date, the one SELECT's UID order is built from. SINCE is
 * "on or after", BEFORE is "before", ON is that one UTC day; the `sent*` forms read the same column because the
 * bridge stores no separate Date: header, which the table in `imap-search.ts` documents.
 */
const DATE_CONDITIONS: Record<ImapSearchDateField, (start: number) => SQL> = {
	since: (start) => gte(messages.createdAt, new Date(start)),
	"sent-since": (start) => gte(messages.createdAt, new Date(start)),
	before: (start) => lt(messages.createdAt, new Date(start)),
	"sent-before": (start) => lt(messages.createdAt, new Date(start)),
	on: (start) => and(gte(messages.createdAt, new Date(start)), lt(messages.createdAt, new Date(start + DAY_MS)))!,
	"sent-on": (start) => and(gte(messages.createdAt, new Date(start)), lt(messages.createdAt, new Date(start + DAY_MS)))!,
};

/**
 * Render one criteria tree as a single WHERE predicate over `messages`.
 *
 * `orderedIds` is the selected mailbox in sequence order (the ids `mailboxMessages` numbers), which is what makes
 * the positional criteria — a bare sequence set and `UID` — expressible in SQL: the set resolves to positions,
 * the positions resolve to message ids, and a set that names no message becomes `1 = 0` instead of being an
 * error. Everything else is a column predicate, so one query answers the whole SEARCH.
 *
 * The combinators are the RFC's own: `NOT` of a predicate, `OR` of two, and the implicit AND of a key list. No
 * predicate is NULL for a stored row (text uses `coalesce`, flags read NOT NULL columns), so `NOT` means "the
 * rows the inner predicate does not match" rather than SQL's unknown.
 */
export function buildImapSearchConditions(criteria: ImapSearchCriteria, orderedIds: string[]): SQL {
	switch (criteria.kind) {
		case "all":
			return matchEverything;
		case "empty":
			return matchNothing;
		case "and":
			return and(...criteria.criteria.map((child) => buildImapSearchConditions(child, orderedIds)))!;
		case "or":
			return or(buildImapSearchConditions(criteria.left, orderedIds), buildImapSearchConditions(criteria.right, orderedIds))!;
		case "not":
			return not(buildImapSearchConditions(criteria.criteria, orderedIds));
		case "flag":
			return FLAG_CONDITIONS[criteria.flag]();
		case "text":
			return TEXT_CONDITIONS[criteria.field](criteria.value);
		case "date":
			return DATE_CONDITIONS[criteria.field](criteria.start);
		case "position": {
			const ids = resolveImapSet(criteria.set, orderedIds.length).map((position) => orderedIds[position - 1]);
			return ids.length > 0 ? inArray(messages.id, ids) : matchNothing;
		}
	}
}
