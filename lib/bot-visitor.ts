/**
 * Bots join rooms through the same room-access check as players, identified as `bot-<bot id>` (the bot's UUID in
 * Orbit). Matching the whole shape, not just the prefix, keeps a person whose identifier happens to start with
 * "bot-" (an email such as bot-fan@example.com) counted as a person.
 */
const BOT_IDENTIFIER = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBotIdentifier(identifier: string | null | undefined): boolean {
  return typeof identifier === 'string' && BOT_IDENTIFIER.test(identifier);
}
