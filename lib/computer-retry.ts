/** The wait before something that failed is tried again: one minute, growing (doubling) to an hour. Shared by the give-back decisions and the refund obligations. */
export const retryWaitMs = (attempts: number): number => Math.min(2 ** Math.max(0, attempts), 60) * 60 * 1000;
