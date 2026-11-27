/**
 * The one text stream every dialect's attachment-text index is fed and queried
 * through (F53 gate round 1).
 *
 * Each engine's own tokenizer reads attachment text differently: PostgreSQL's
 * 'simple' dictionary does not fold accents and keeps an email or URL as a
 * single token, MySQL's FULLTEXT index drops tokens shorter than
 * `innodb_ft_min_token_size` and every stock stopword, and SQLite's unicode61
 * folds diacritics but indexes one-character tokens MySQL never records. The
 * result was identical queries answering differently per dialect — safe on the
 * positive side, but a negated term an engine could not tokenize silently
 * under-excluded on that engine only (`quick -the` kept the row on MySQL).
 *
 * The fix is to normalize before the engine ever sees the text. The extraction
 * path writes the output of this function into `message_attachments.search_text`
 * and every dialect indexes that column (GIN on PostgreSQL, FULLTEXT on MySQL,
 * FTS5 through `attachments_fts_source` on SQLite); query terms pass through the
 * same function before a `to_tsquery`, `AGAINST` or `MATCH` expression is built.
 * What reaches any tokenizer is then a flat stream of lower-case, accent-free,
 * punctuation-free indexable tokens — nothing left for the engines to disagree
 * on — so identical input yields identical postings and identical result sets
 * by construction.
 */

/**
 * The token bounds of the narrowest index any dialect offers: MySQL's stock
 * InnoDB configuration (`innodb_ft_min_token_size` = 3, `innodb_ft_max_token_size`
 * = 84). Tokens outside them are dropped from the indexed stream AND from query
 * terms, so SQLite and PostgreSQL "drop" the same words MySQL could never index
 * and no dialect can see a posting the others lack.
 */
export const ATTACHMENT_SEARCH_MIN_TOKEN_CHARS = 3;
export const ATTACHMENT_SEARCH_MAX_TOKEN_CHARS = 84;

/**
 * InnoDB's built-in stopword list — the 35 distinct words a stock FULLTEXT
 * index never records (information_schema.INNODB_FT_DEFAULT_STOPWORD). They are
 * dropped everywhere for the same reason the size bounds are: an unindexable
 * token must not divide the dialects. The list is fixed in the server; a
 * deployment that configures its own stopword table or raises/lowers the token
 * bounds only changes what MySQL *could* index — the shared stream below stays
 * the contract (see docs/databases.md).
 */
const UNINDEXABLE_WORDS = new Set([
	"a", "about", "an", "are", "as", "at", "be", "by", "com", "de", "en", "for",
	"from", "how", "i", "in", "is", "it", "la", "of", "on", "or", "that", "the",
	"this", "to", "und", "was", "what", "when", "where", "who", "will", "with",
	"www",
]);

/**
 * Attachment text as the tokens every index is allowed to keep: NFD-decompose,
 * strip combining marks (accent fold), lower-case, treat anything that is not a
 * letter or digit as a separator, and drop tokens no stock MySQL index could
 * hold. Returns "" when nothing indexable remains.
 *
 * Applied identically to the document (the `search_text` write path in
 * attachment-text.ts and the backfill in index-admin.ts) and to every query
 * term (the `buildAttachment*` builders in query-utils.ts). Because a term can
 * normalize to "" here — "the", "x", a bare punctuation run — a search clause
 * can legitimately vanish: for a negated term that means the negation is simply
 * not applied, on every dialect alike (permissive-equal; the alternative, a
 * per-dialect under-exclusion, is the bug this removes). Documented behavior,
 * never an error.
 */
export function normalizeSearchText(text: string | null | undefined): string {
	if (!text) return "";
	const folded = text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
	const tokens: string[] = [];
	for (const word of folded.split(/[^\p{L}\p{N}]+/u)) {
		if (word.length < ATTACHMENT_SEARCH_MIN_TOKEN_CHARS) continue;
		if (word.length > ATTACHMENT_SEARCH_MAX_TOKEN_CHARS) continue;
		if (UNINDEXABLE_WORDS.has(word)) continue;
		tokens.push(word);
	}
	return tokens.join(" ");
}
