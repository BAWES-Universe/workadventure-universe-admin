import { canManageThisBot, type ManageMemo, type ManagedBot } from '@/lib/bot-permissions';

/**
 * The parts of a bot only the people who manage it may read (#797): what its maker wrote to steer it, which AI key and
 * model it runs on, and its reply limits. Everyone else who can see the room gets the bot's public card: name, look,
 * companion, on/off, behaviour type and its spot and route (all visible in the room), who made it by name, and the room.
 */
export const PRIVATE_BOT_FIELDS = [
  'chatInstructions',
  'movementInstructions',
  'aiProviderRef',
  'aiModel',
  'toolTimeoutSeconds',
  'maxReplyTokens',
  'maxSteps',
] as const;

/** Keys inside a bot's behavior config that point at an AI key (the Vision pick, #374), so they stay private too. */
const PRIVATE_BEHAVIOR_KEYS = ['vision'] as const;

type Card = Record<string, unknown>;

/** A copy of a bot's API shape without its private parts. */
export function toPublicBotCard<T extends Card>(bot: T): Omit<T, (typeof PRIVATE_BOT_FIELDS)[number]> {
  const card: Card = { ...bot };
  for (const field of PRIVATE_BOT_FIELDS) delete card[field];
  const config = card.behaviorConfig;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const publicConfig: Card = { ...(config as Card) };
    for (const key of PRIVATE_BEHAVIOR_KEYS) delete publicConfig[key];
    card.behaviorConfig = publicConfig;
  }
  return card as Omit<T, (typeof PRIVATE_BOT_FIELDS)[number]>;
}

/**
 * Whether the reader may see a bot's private parts: the bot server's admin token, or someone who manages this bot (the
 * same check a save uses, so the room editor shows exactly what they may change; super admins always do). Anyone else,
 * including someone not signed in, gets the public card.
 */
export async function maySeeBotPrivateParts(
  reader: { userId: string | null; userEmail: string | null; isAdminToken: boolean },
  bot: ManagedBot,
  /** For a list of bots: the answers kept for this one request (see ManageMemo), so the reader's standing in the room is worked out once. */
  memo?: ManageMemo,
): Promise<boolean> {
  if (reader.isAdminToken) return true;
  if (!reader.userId) return false;
  return canManageThisBot(reader.userId, reader.userEmail, bot, { creatorPasses: false, memo });
}
