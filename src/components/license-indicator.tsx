"use client";

// Premium is always on in this product build (see getLicenseEntitlements), so the
// license state is never shown and there is no upgrade CTA.
export function LicenseIndicator() {
	return null;
}
