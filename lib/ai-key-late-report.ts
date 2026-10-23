/**
 * A bot's model changed in the last few minutes (#575): moved off a gone model to one that answered, picked again by its
 * maker, or moved to another key. A lend that stops allowing a model moves bots off one that worked, so it opens no window: a
 * 404 just after is about the model the owner picked for them, and counts. A model-gone report then is about the model it had, from a reply already
 * on its way, so it is let go instead of counting against the key the bot is on now. Kept per bot, whatever key it is on.
 * A key's check model changing changes the model of every bot that follows it (no model of its own), so that is kept too.
 */

/** How long after a change a model-gone report for that bot is taken as late news about the model it had. */
export const LATE_REPORT_MS = 10 * 60_000;
const changedAt = new Map<string, number>();
const checkModelChangedAt = new Map<string, number>();
const recent = (at: number | undefined) => at !== undefined && Date.now() - at < LATE_REPORT_MS;
/** Notes past the window say nothing any more: they are dropped as new ones come in, so the maps stay small. */
const note = (map: Map<string, number>, id: string, at: number) => {
  for (const [entry, value] of map) if (at - value >= LATE_REPORT_MS) map.delete(entry);
  map.set(id, at);
};

/** Returns how to take the note back, for a save that then fails: the bot's model did not change after all. */
export function noteModelChanged(botId: string): () => void {
  const before = changedAt.get(botId);
  note(changedAt, botId, Date.now());
  return () => {
    if (before === undefined) changedAt.delete(botId);
    else changedAt.set(botId, before);
  };
}

/** The key got a new check model: every bot on it with no model of its own now replies with that one. */
export function noteCheckModelChanged(providerId: string): void {
  note(checkModelChangedAt, providerId, Date.now());
}

/**
 * Whether this bot's model changed in the last few minutes: its own, or the check model of the key it follows. `followsCheck`:
 * the bot replies with the key's check model (no model of its own, and its lend allows it).
 */
export function changedLately(bot: { id: string; aiModel: string | null }, providerId: string, followsCheck = bot.aiModel === null): boolean {
  return recent(changedAt.get(bot.id)) || (followsCheck && recent(checkModelChangedAt.get(providerId)));
}
