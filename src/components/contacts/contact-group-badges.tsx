"use client";

import { Tag01 } from "@/components/icons";
import type { ContactGroup } from "./contact-groups-types";

/** Group chips under a contact row — the same badge idiom the blocked label uses. */
export function ContactGroupBadges({ groups }: { groups: ContactGroup[] }) {
	if (groups.length === 0) return null;
	return (
		<span className="mt-1 flex flex-wrap items-center gap-1">
			{groups.map((group) => (
				<span
					key={group.id}
					className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700"
				>
					<Tag01 className="h-3 w-3" />
					<span className="max-w-32 truncate">{group.name}</span>
				</span>
			))}
		</span>
	);
}
