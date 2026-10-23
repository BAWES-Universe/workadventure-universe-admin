/**
 * A bot's model changed in the last few minutes (#575): moved off a gone model, picked again by its maker, moved to another
 * key, or moved because a lend stopped allowing it. A model-gone report then is about the model it had, from a reply already
 * on its way, so it is let go instead of counting against the key the bot is on now. Kept per bot, whatever key it is on.
 */

/** How long after a change a model-gone report for that bot is taken as late news about the model it had. */
export const LATE_REPORT_MS = 10 * 60_000;
const changedAt = new Map<string, number>();

export function noteModelChanged(botId: string): void {
  changedAt.set(botId, Date.now());
}

export function changedLately(botId: string): boolean {
  const at = changedAt.get(botId);
  return at !== undefined && Date.now() - at < LATE_REPORT_MS;
}
