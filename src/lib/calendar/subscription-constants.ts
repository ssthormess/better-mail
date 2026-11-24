/** The cron ticks every five minutes, so a shorter interval could never be honored. */
export const MIN_REFRESH_INTERVAL_SEC = 300;
/** A month between pulls is long enough for even the quietest feed. */
export const MAX_REFRESH_INTERVAL_SEC = 30 * 24 * 3600;
export const DEFAULT_REFRESH_INTERVAL_SEC = 3600;
