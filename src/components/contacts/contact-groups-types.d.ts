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
