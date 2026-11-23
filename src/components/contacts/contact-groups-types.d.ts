/** A group row as `/api/contacts/groups` returns it: the persisted columns plus the member count. */
export type ContactGroup = {
	id: string;
	userId: string;
	name: string;
	createdAt: string;
	memberCount: number;
};

/** A member row as `/api/contacts/groups/[id]/members` returns it: the join row plus the contact fields. */
export type ContactGroupMember = {
	id: string;
	contactId: string;
	email: string;
	displayName: string | null;
	hasAvatar: boolean;
	createdAt: string;
};

export type ContactGroupsIndexResponse = {
	groups?: ContactGroup[];
	error?: unknown;
};

export type ContactGroupResponse = {
	group?: ContactGroup;
	error?: unknown;
};

/** PATCH answers the raw row without a memberCount — the cache keeps its own count. */
export type ContactGroupUpdateResponse = {
	group?: Omit<ContactGroup, "memberCount">;
	error?: unknown;
};

export type ContactGroupMembersResponse = {
	members?: ContactGroupMember[];
	error?: unknown;
};

/**
 * One snapshot serves the manager, the assign dialog and the row badges: the
 * index rows plus every group's member list, so membership is resolved
 * client-side instead of per contact.
 */
export type ContactGroupsData = {
	groups: ContactGroup[];
	membersByGroup: Record<string, ContactGroupMember[]>;
};
