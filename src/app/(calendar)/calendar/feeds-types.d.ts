/** One row of `GET /api/calendar/subscriptions` — dates arrive ISO-serialized. */
export type CalendarSubscription = {
	id: string;
	feedUrl: string;
	title: string;
	etag: string | null;
	lastModified: string | null;
	refreshIntervalSec: number;
	lastRefreshAt: string | null;
	lastRefreshStatus: number | null;
	lastError: string | null;
	eventCount: number;
	createdAt: string;
	updatedAt: string;
};

export type SubscriptionPatchInput = {
	title?: string;
	refreshIntervalSec?: number;
};

export type SubscriptionCreateInput = {
	url: string;
	title?: string;
	refreshIntervalSec?: number;
};

/** `POST /api/calendar/subscriptions` success body. */
export type SubscriptionCreateResult = {
	subscription: CalendarSubscription;
	added: number;
	skipped: number;
	errors: string[];
};

export type CalendarFeedsDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Runs after a feed is added or removed — its events landed or left with it. */
	onChanged?: () => void;
	/** Where focus lands when the dialog closes — the menu item that opened it is unmounted by then. */
	returnFocusRef?: { current: HTMLButtonElement | null };
};

export type FeedsAddFormProps = {
	onAdd: (input: SubscriptionCreateInput) => Promise<SubscriptionCreateResult>;
};

export type FeedsListProps = {
	/** null while the first load is in flight. */
	subscriptions: CalendarSubscription[] | null;
	loadError: boolean;
	/** The account was denied the feature — the list request answered 403. */
	denied: boolean;
	editingId: string | null;
	pendingId: string | null;
	onRetry: () => void;
	onEdit: (id: string) => void;
	onCancelEdit: () => void;
	onSave: (id: string, patch: SubscriptionPatchInput) => Promise<CalendarSubscription>;
	onDelete: (subscription: CalendarSubscription) => void;
};

export type FeedRowProps = {
	subscription: CalendarSubscription;
	pending: boolean;
	onEdit: () => void;
	onDelete: () => void;
};

export type FeedEditRowProps = {
	subscription: CalendarSubscription;
	pending: boolean;
	onSave: (patch: SubscriptionPatchInput) => Promise<CalendarSubscription>;
	onCancel: () => void;
};
