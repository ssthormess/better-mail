// The same slice of a contacts row the vCard export uses. The CSV carries the
// identical information: the blocked flag becomes a column the way the card
// marks it CATEGORIES:Blocked.
export interface ContactCsvRow {
	email: string;
	displayName: string | null;
	blocked: boolean;
}

// RFC 4180 is small enough to write by hand — quote on comma/quote/line break,
// double inner quotes, CRLF rows — so no dependency is warranted.
function csvField(value: string): string {
	// Spreadsheet-formula injection guard (OWASP): Excel and Sheets evaluate a
	// cell starting with = + - @ as a formula, and strip leading whitespace
	// first, so a hostile contact name could otherwise run commands or phone
	// home. A leading ' makes importers read the cell as literal text.
	if (/^\s*[=+\-@]/.test(value)) value = `'${value}`;
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Header plus one row per contact, CRLF endings. The leading U+FEFF BOM makes
 * Excel open the file as UTF-8 — without it Excel guesses an ANSI codepage and
 * mangles non-ASCII names; RFC 4180 readers just see it as part of the header.
 */
export function contactsToCsv(rows: ContactCsvRow[]): string {
	const lines = ["name,email,blocked"];
	for (const row of rows) {
		lines.push([csvField(row.displayName ?? ""), csvField(row.email), row.blocked ? "true" : "false"].join(","));
	}
	return `\uFEFF${lines.join("\r\n")}\r\n`;
}
