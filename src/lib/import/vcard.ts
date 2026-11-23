import { normalizeEmailAddress } from "@/lib/email/address";
import { parseAddress } from "@/lib/utils";

// The shared import decoder; kept under its original name for the vCard upload path.
export { decodeTextBytes as decodeVcfBytes } from "@/lib/import/text";

// A hand-rolled reader, on purpose: the maintained options each miss something this
// import needs. `vcf`@2.1.x (the popular parser) never decodes ENCODING=QUOTED-PRINTABLE
// or CHARSET and does not join vCard 2.1 "=" soft-wrap continuations, `vcard4` only
// accepts RFC 6350 (v4) input while real exports are 2.1/3.0, and `vcardz` has been
// unmaintained since 2022. What remains is a small bounded surface: BEGIN/END card
// splitting, both folding styles, and only the EMAIL + FN properties the contacts
// table stores — every other property is read over and ignored by design.

/** Upper bound on BEGIN:VCARD blocks read from one upload; later cards count as skipped. */
export const VCARD_IMPORT_MAX_CARDS = 2000;
/** Same bound POST /api/contacts applies to a display name. */
const DISPLAY_NAME_MAX_LENGTH = 100;

export interface ParsedVCardContact {
	email: string;
	/** Undefined when the card has no usable FN, so an upsert keeps a stored name. */
	displayName: string | undefined;
}

export interface VCardImportParseResult {
	contacts: ParsedVCardContact[];
	/**
	 * Cards dropped before any write: unterminated or empty cards, cards without a
	 * usable EMAIL, duplicates of an earlier card in the same file, and cards past
	 * the import cap.
	 */
	skipped: number;
}

const CARD_BEGIN = /^begin:vcard$/i;
const CARD_END = /^end:vcard$/i;

/** Yields each BEGIN:VCARD block; a file truncated mid-card yields it once with `complete: false`. */
function* iterCardLines(lines: string[]): Generator<{ lines: string[]; complete: boolean }> {
	let card: string[] | null = null;
	for (const line of lines) {
		if (card === null) {
			if (CARD_BEGIN.test(line.trim())) card = [];
			continue;
		}
		if (CARD_END.test(line.trim())) {
			yield { lines: card, complete: true };
			card = null;
			continue;
		}
		card.push(line);
	}
	if (card !== null) yield { lines: card, complete: false };
}

/** The header portion of a property line: everything before the first unquoted ":". */
function headerOf(line: string): string {
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') quoted = !quoted;
		else if (char === ":" && !quoted) return line.slice(0, i);
	}
	return line;
}

/** `NAME;PARAMS` split at the first ";" — params keep their raw text, quoted colons stay out of reach. */
function parseProperty(line: string): { name: string; params: string; value: string } | null {
	const header = headerOf(line);
	if (header.length === line.length) return null;
	const semi = header.indexOf(";");
	const rawName = (semi === -1 ? header : header.slice(0, semi)).trim();
	// Apple and others prefix properties with a group: "item1.EMAIL".
	const name = rawName.slice(rawName.lastIndexOf(".") + 1).toUpperCase();
	if (!/^[A-Z0-9-]+$/.test(name)) return null;
	return { name, params: semi === -1 ? "" : header.slice(semi + 1), value: line.slice(header.length + 1) };
}

function paramValue(params: string, key: string): string | null {
	const match = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*"?([^";]+)"?`, "i").exec(params);
	return match?.[1]?.trim() ?? null;
}

/** Whether the header declares a quoted-printable value, written `ENCODING=QUOTED-PRINTABLE` or as a bare 2.1 token. */
function isQuotedPrintableHeader(header: string): boolean {
	return /^quoted-printable$/i.test(paramValue(header, "ENCODING") ?? "") || /;\s*quoted-printable\s*(?=;|$)/i.test(header);
}

/**
 * Physical lines to logical property lines. vCard 3.0/4.0 folds by starting the
 * next line with a space or tab; vCard 2.1 instead wraps a quoted-printable value
 * at ~75 chars with a trailing "=" and no leading whitespace on the continuation.
 */
function logicalLines(card: string[]): string[] {
	const lines: string[] = [];
	for (const line of card) {
		if (line === "") continue;
		const last = lines.length - 1;
		if (last >= 0 && (line[0] === " " || line[0] === "\t")) {
			lines[last] += line.slice(1);
			continue;
		}
		if (last >= 0 && lines[last].endsWith("=") && isQuotedPrintableHeader(headerOf(lines[last]))) {
			lines[last] = lines[last].slice(0, -1) + line;
			continue;
		}
		lines.push(line);
	}
	return lines;
}

function decodeQuotedPrintable(value: string): Uint8Array {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "=") {
			const hex = value.slice(i + 1, i + 3);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				bytes.push(parseInt(hex, 16));
				i += 2;
				continue;
			}
			// A "=" before a line break is a soft break — already joined upstream, but stay safe.
			if (/^=[\r\n]/.test(value.slice(i, i + 2))) {
				i += value[i + 1] === "\r" && value[i + 2] === "\n" ? 2 : 1;
				continue;
			}
		}
		bytes.push(char.charCodeAt(0) & 0xff);
	}
	return new Uint8Array(bytes);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value.replace(/\s+/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		// An unknown CHARSET label decodes as UTF-8 rather than losing the card.
		return new TextDecoder().decode(bytes);
	}
}

/** RFC 2426/6350 text escapes: \\, \n, \, and \;. */
function unescapeText(value: string): string {
	return value.replace(/\\(.)/g, (match, char: string) =>
		char === "n" || char === "N" ? "\n" : /[\\,;]/.test(char) ? char : match,
	);
}

/** Decode a property value honouring ENCODING (2.1) and CHARSET; plain values pass through unescaped. */
function decodePropertyValue(params: string, value: string): string {
	const encoding = (paramValue(params, "ENCODING") ?? (/;\s*quoted-printable\s*(?=;|$)/i.test(params) ? "QUOTED-PRINTABLE" : "")).toUpperCase();
	if (encoding === "QUOTED-PRINTABLE" || encoding === "QP") {
		return unescapeText(decodeBytes(decodeQuotedPrintable(value), paramValue(params, "CHARSET") ?? "utf-8"));
	}
	if (encoding === "BASE64" || encoding === "B") {
		try {
			return unescapeText(decodeBytes(decodeBase64(value), paramValue(params, "CHARSET") ?? "utf-8"));
		} catch {
			return "";
		}
	}
	return unescapeText(value);
}

/** Multiple EMAIL properties per card: the one marked PREF wins, otherwise the first. */
function pickEmailValue(candidates: { params: string; value: string }[]): string | null {
	const pref = candidates.find((candidate) => /\bpref\b/i.test(candidate.params));
	const chosen = pref ?? candidates[0];
	return chosen?.value ?? null;
}

/** Reduce one card to the address + name the contacts table stores; null when there is no usable email. */
function contactFromCard(card: string[]): ParsedVCardContact | null {
	let displayName: string | undefined;
	const emails: { params: string; value: string }[] = [];
	for (const line of logicalLines(card)) {
		const property = parseProperty(line);
		if (!property) continue;
		if (property.name === "FN" && displayName === undefined) {
			const name = decodePropertyValue(property.params, property.value).trim();
			if (name) displayName = name;
		} else if (property.name === "EMAIL") {
			const value = decodePropertyValue(property.params, property.value).trim();
			if (value) emails.push({ params: property.params, value });
		}
	}

	const raw = pickEmailValue(emails)?.replace(/^mailto:/i, "") ?? "";
	const email = normalizeEmailAddress(raw);
	if (!parseAddress(email)) return null;

	// A 100+ char name is truncated to the same bound POST /api/contacts enforces.
	if (displayName && displayName.length > DISPLAY_NAME_MAX_LENGTH) {
		displayName = displayName.slice(0, DISPLAY_NAME_MAX_LENGTH);
	}
	return { email, displayName };
}

/**
 * Parse a .vcf document into the contacts it names. The result is deduplicated by
 * address — when the same email appears twice, the file's first card wins. Cards
 * past `maxCards` are not read at all and land in `skipped`.
 */
export function parseVcfContacts(text: string, maxCards = VCARD_IMPORT_MAX_CARDS): VCardImportParseResult {
	const lines = text.split(/\r\n?|\n/);
	const contacts: ParsedVCardContact[] = [];
	const seen = new Set<string>();
	let skipped = 0;
	let read = 0;
	for (const card of iterCardLines(lines)) {
		read++;
		if (!card.complete || read > maxCards) {
			skipped++;
			continue;
		}
		const contact = contactFromCard(card.lines);
		if (!contact || seen.has(contact.email)) {
			skipped++;
			continue;
		}
		seen.add(contact.email);
		contacts.push(contact);
	}
	return { contacts, skipped };
}
