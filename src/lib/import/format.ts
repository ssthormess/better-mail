export type ContactImportFormat = "csv" | "vcf";

/**
 * Which parser an upload gets — an explicit `format` value first, then the
 * filename's extension, then the content type (browsers send both unreliably),
 * and otherwise vCard so clients that only ever sent .vcf stay put. The API
 * route and the contacts file picker share this one classifier: a pick the
 * route will read as CSV opens the preview dialog, and only the known vCard
 * path writes directly, so the two can never drift apart. Returns null for an
 * explicit format value that is not supported.
 */
export function resolveContactImportFormat(declared: string, filename: string, contentType: string): ContactImportFormat | null {
	const normalized = declared.trim().toLowerCase();
	if (normalized === "csv" || normalized === "vcf") return normalized;
	if (normalized) return null;
	if (/\.csv$/i.test(filename)) return "csv";
	if (/\.(vcf|vcard)$/i.test(filename)) return "vcf";
	if (/^(text\/csv|application\/vnd\.ms-excel)$/i.test(contentType)) return "csv";
	return "vcf";
}
