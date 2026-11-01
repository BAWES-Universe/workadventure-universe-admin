/** How long a Down key waits before it is tried again (text keys and voice keys). Free of server code, so pages can say it in minutes. */
export const RECHECK_MS = 5 * 60_000;

/** The wait in whole minutes, for the line a person reads. */
export const RECHECK_MINUTES = Math.round(RECHECK_MS / 60_000);
