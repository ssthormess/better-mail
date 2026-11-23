/**
 * Decode an uploaded text import (vCard, CSV) to a string. These files are
 * usually UTF-8, but old desktop tools also wrote UTF-16 — sniff its BOM first.
 * A UTF-8 BOM is consumed by the decoder.
 */
export function decodeTextBytes(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		return new TextDecoder("utf-16be").decode(bytes.subarray(2));
	}
	return new TextDecoder().decode(bytes);
}
