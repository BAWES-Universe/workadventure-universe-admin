/**
 * A bot's model changed in the last few minutes (#575): moved off a gone model, picked again by its maker, moved to another
 * key, or moved because a lend stopped allowing it. A model-gone report then is about the model it had, from a reply already
 * on its way, so it is let go instead of counting against the key the bot is on now. Kept per bot, whatever key it is on.
 * A key's check model changing changes the model of every bot that follows it (no model of its own), so that is kept too.
 */

/** How long after a change a model-gone report for that bot is taken as late news about the model it had. */
export const LATE_REPORT_MS = 10 * 60_000;
const changedAt = new Map<string, number>();
const checkModelChangedAt = new Map<string, number>();
const recent = (at: number | undefined) => at !== undefined && Date.now() - at < LATE_REPORT_MS;

export function noteModelChanged(botId: string): void {
  changedAt.set(botId, Date.now());
}

/** The key got a new check model: every bot on it with no model of its own now replies with that one. */
export function noteCheckModelChanged(providerId: string): void {
  checkModelChangedAt.set(providerId, Date.now());
}

/** Whether this bot's model changed in the last few minutes: its own, or the check model of the key it follows. */
export function changedLately(bot: { id: string; aiModel: string | null }, providerId: string): boolean {
  return recent(changedAt.get(bot.id)) || (bot.aiModel === null && recent(checkModelChangedAt.get(providerId)));
}
