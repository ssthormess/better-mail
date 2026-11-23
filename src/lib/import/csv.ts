import { normalizeEmailAddress } from "@/lib/email/address";
import { parseAddress } from "@/lib/utils";

// The read side of RFC 4180, hand-rolled for the same reason the write side in
// src/lib/export/csv.ts is: the grammar is a small state machine — quoted fields
// with "" escapes and embedded line breaks — and a dependency would mostly add
// column-mapping and typing this import does not need.
//
// Column mapping is heuristic, because real CSV exports disagree on headers:
//   - a first record naming a name/email/blocked column (and carrying no "@")
//     is a header, and columns are bound by name — the "E-mail 1 - Value" style
//     headers Google and Outlook write are matched by the same email regex, but
//     only value/address columns bind: "… - Label"/"… - Type" columns hold the
//     address's kind ("Home"), never the address;
//   - a first record whose vocabulary matches but binds no email column is NOT
//     a header — it reads as data under the positional fallback, so one
//     "Name,missing" row cannot consume the file's column mapping;
//   - without one, columns fall back to the order our own export writes
//     (name, email, …), and a single-column file is read as a bare email list.
// The blocked column is detected but its values are ignored, matching the vCard
// path, which likewise does not act on CATEGORIES:Blocked.

/** Upper bound on data rows read from one upload; later rows count as skipped. */
export const CSV_IMPORT_MAX_ROWS = 2000;
/** Same bound POST /api/contacts applies to a display name. */
const DISPLAY_NAME_MAX_LENGTH = 100;
/**
 * An address cell longer than this cannot be an address (an addr-spec tops out
 * at 254; the slack covers a "Name <a@b>" form). Oversized cells classify as
 * invalid instead of being normalized, matched or echoed whole into a preview.
 */
const EMAIL_CELL_MAX_LENGTH = 320;
/** An invalid row echoes its raw cell into the preview bounded to this length. */
const INVALID_ECHO_MAX_LENGTH = 120;

export interface ParsedCsvContact {
	email: string;
	/** Undefined when the row has no usable name, so an upsert keeps a stored one. */
	displayName: string | undefined;
}

export type CsvRowStatus = "ok" | "invalid" | "dup";

export interface CsvImportRow {
	/** Spreadsheet row number — the header is row 1 when the file has one. */
	row: number;
	email: string | null;
	displayName: string | undefined;
	status: CsvRowStatus;
}

export interface CsvImportParseResult {
	/** Valid deduplicated contacts, ready to upsert — the file's first row wins. */
	contacts: ParsedCsvContact[];
	/** Every data row up to the cap, classified for preview. */
	rows: CsvImportRow[];
	/** Data rows past `maxRows`, never classified. */
	skipped: number;
}

/**
 * Yields each record as its fields with a 1-based record number. Unquoted fields
 * are trimmed; quoted content is kept verbatim. A quote anywhere but at a
 * field's start is literal text, and a file ending mid-quote or without a final
 * line break still yields its last record rather than failing.
 */
function* iterRecords(text: string): Generator<{ row: number; fields: string[] }> {
	let fields: string[] = [];
	let field = "";
	let fieldStart = true;
	let fieldQuoted = false;
	let quoted = false;
	let row = 0;
	const endField = () => {
		fields.push(fieldQuoted ? field : field.trim());
		field = "";
		fieldStart = true;
		fieldQuoted = false;
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && fieldStart) {
			quoted = true;
			fieldQuoted = true;
			fieldStart = false;
			continue;
		}
		if (char === ",") {
			endField();
			continue;
		}
		if (char === "\r" || char === "\n") {
			if (char === "\r" && text[i + 1] === "\n") i++;
			endField();
			yield { row: ++row, fields };
			fields = [];
			continue;
		}
		field += char;
		fieldStart = false;
	}
	if (field !== "" || fields.length > 0 || quoted) {
		endField();
		yield { row: ++row, fields };
	}
}

const EMAIL_HEADER = /\be-?mails?\b/i;
// Google and Outlook write a kind column next to the address one — "E-mail 1 -
// Label"/"E-mail 1 - Type" holds "Home", "E-mail 1 - Value"/"E-mail Address"
// holds the address. A label/type column must never bind as the email column.
const EMAIL_KIND_HEADER = /[\s-](?:label|type)$/i;
const EMAIL_VALUE_HEADER = /[\s-](?:value|address)$/i;
const NAME_HEADERS_PRIMARY = new Set(["name", "display name", "full name"]);
const NAME_HEADERS_SECONDARY = new Set(["first name", "given name", "family name", "last name", "nickname"]);
const BLOCKED_HEADER = /^blocked$/i;

const normalizeHeader = (cell: string) => cell.trim().toLowerCase().replace(/\s+/g, " ");

function findColumn(headers: string[], match: (cell: string) => boolean): number {
	return headers.findIndex((cell) => match(normalizeHeader(cell)));
}

/** The address-bearing email column: the first *- Value/*- Address one, else the first that is not a label/type. */
function findEmailColumn(headers: string[]): number {
	let fallback = -1;
	for (let i = 0; i < headers.length; i++) {
		const header = normalizeHeader(headers[i]);
		if (!EMAIL_HEADER.test(header) || EMAIL_KIND_HEADER.test(header)) continue;
		if (EMAIL_VALUE_HEADER.test(header)) return i;
		if (fallback === -1) fallback = i;
	}
	return fallback;
}

/** Whether the first record names columns rather than carrying a contact. */
function isHeaderRow(fields: string[]): boolean {
	if (fields.some((cell) => cell.includes("@"))) return false;
	return fields.some((cell) => {
		const header = normalizeHeader(cell);
		return EMAIL_HEADER.test(header) || NAME_HEADERS_PRIMARY.has(header) || NAME_HEADERS_SECONDARY.has(header) || BLOCKED_HEADER.test(header);
	});
}

interface ColumnMap {
	email: number;
	/** -1 when the file has no usable name column. */
	name: number;
}

function mapColumns(fields: string[]): { columns: ColumnMap; header: boolean } {
	if (isHeaderRow(fields)) {
		const email = findEmailColumn(fields);
		if (email >= 0) {
			let name = findColumn(fields, (cell) => NAME_HEADERS_PRIMARY.has(cell));
			if (name === -1) name = findColumn(fields, (cell) => NAME_HEADERS_SECONDARY.has(cell));
			return { columns: { email, name }, header: true };
		}
		// A "header" that binds no email column cannot map the file — it reads as
		// ordinary data so a stray first row does not poison every later row.
	}
	// No header: the export's own column order. A one-column file is a bare
	// address list — reading it as name,email would invalidate every row.
	return { columns: fields.length === 1 ? { email: 0, name: -1 } : { email: 1, name: 0 }, header: false };
}

function contactFromRow(fields: string[], columns: ColumnMap): ParsedCsvContact | null {
	const raw = fields[columns.email];
	if (raw === undefined || raw.length > EMAIL_CELL_MAX_LENGTH) return null;
	const email = normalizeEmailAddress(raw);
	// A surviving ":" means the cell was prefixed garbage ("EMAIL:a@b",
	// "mailto:a@b") rather than an address or a "Name <a@b>" form — reject it.
	if (email.includes(":") || !parseAddress(email)) return null;
	let displayName = columns.name >= 0 ? fields[columns.name]?.trim() : undefined;
	if (!displayName) displayName = undefined;
	// A 100+ char name is truncated to the same bound POST /api/contacts enforces.
	if (displayName && displayName.length > DISPLAY_NAME_MAX_LENGTH) displayName = displayName.slice(0, DISPLAY_NAME_MAX_LENGTH);
	return { email, displayName };
}

/**
 * Parse a contacts CSV document. `contacts` is deduplicated by address — when an
 * email repeats, the file's first row wins and the later ones are `dup` in
 * `rows`. Rows without a usable email are `invalid`; rows past `maxRows` are not
 * classified at all and land in `skipped`. Blank lines are ignored entirely.
 */
export function parseCsvContacts(text: string, maxRows = CSV_IMPORT_MAX_ROWS): CsvImportParseResult {
	// TextDecoder already consumes a UTF-8 BOM; strip a literal U+FEFF for inputs
	// that were decoded elsewhere.
	const records = iterRecords(text.replace(/^\uFEFF/, ""));
	const contacts: ParsedCsvContact[] = [];
	const rows: CsvImportRow[] = [];
	const seen = new Set<string>();
	let skipped = 0;
	let columns: ColumnMap | null = null;
	let dataRow = 0;

	for (const record of records) {
		if (record.fields.every((cell) => cell.trim() === "")) continue;
		if (columns === null) {
			const mapped = mapColumns(record.fields);
			columns = mapped.columns;
			// A header record is consumed here; without one this record is data.
			if (mapped.header) continue;
		}
		dataRow++;
		if (dataRow > maxRows) {
			skipped++;
			continue;
		}
		const contact = contactFromRow(record.fields, columns);
		if (!contact) {
			// The echo lets a preview show what was there, bounded so a huge cell
			// cannot inflate the response.
			const echo = record.fields[columns.email]?.trim().slice(0, INVALID_ECHO_MAX_LENGTH);
			rows.push({ row: record.row, email: echo || null, displayName: undefined, status: "invalid" });
			continue;
		}
		if (seen.has(contact.email)) {
			rows.push({ row: record.row, email: contact.email, displayName: contact.displayName, status: "dup" });
			continue;
		}
		seen.add(contact.email);
		contacts.push(contact);
		rows.push({ row: record.row, email: contact.email, displayName: contact.displayName, status: "ok" });
	}
	return { contacts, rows, skipped };
}

/**
 * Whether the text carries a standalone vCard marker line outside any quoted
 * field — a .vcf saved under a .csv name, or a card dropped in unquoted. A
 * marker inside a quoted cell is ordinary cell content (a notes field quoting
 * an example card) and does not disqualify the file, so the scan tracks the
 * same quote state the parser does: `"` opens a field only at a field's start
 * and `""` is an escaped quote.
 */
export function hasVCardMarkers(text: string): boolean {
	let quoted = false;
	for (const line of text.split(/\r\n?|\n/)) {
		if (!quoted && /^\s*(?:begin|end):vcard\s*$/i.test(line)) return true;
		let fieldStart = true;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (quoted) {
				if (char === '"') {
					if (line[i + 1] === '"') i++;
					else quoted = false;
				}
				continue;
			}
			if (char === '"' && fieldStart) {
				quoted = true;
				fieldStart = false;
				continue;
			}
			fieldStart = char === ",";
		}
	}
	return false;
}
