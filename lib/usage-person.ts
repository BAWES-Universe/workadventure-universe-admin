import { prisma } from '@/lib/db';

/**
 * Who a bot reply was for, as usage rows keep it (Orbit #491, game #1159).
 *
 * The bot server knows a person by their WorkAdventure uuid, or by their email when they signed in through OIDC.
 * A signed-in person is matched to their Orbit account so the bot page can show their name; a guest, or someone
 * Orbit does not know, stays a guest and is only ever counted, never named.
 */
export type UsagePerson = { personId: string | null; guest: boolean | null };

export const USAGE_CHANNELS = ['dm', 'nearby'] as const;
export type UsageChannel = (typeof USAGE_CHANNELS)[number];

/** "dm" or "nearby"; the bot server's own word for nearby chat ("world") counts too. Anything else is not recorded. */
export function readUsageChannel(value: unknown): UsageChannel | null {
  if (value === 'dm') return 'dm';
  if (value === 'nearby' || value === 'world') return 'nearby';
  return null;
}

export async function resolveUsagePerson(talkedUserId: unknown, isGuest: unknown): Promise<UsagePerson> {
  // A bot server from before this sends neither, and its rows stay "not told"
  if (typeof talkedUserId !== 'string' || !talkedUserId) {
    return { personId: null, guest: typeof isGuest === 'boolean' ? isGuest : null };
  }
  const isEmail = talkedUserId.includes('@');
  // A guest is never looked up, unless the id is an email, which only a signed-in person has
  if (isGuest === true && !isEmail) return { personId: null, guest: true };
  try {
    const user = await prisma.user.findUnique({
      where: isEmail ? { email: talkedUserId } : { uuid: talkedUserId },
      select: { id: true, isGuest: true },
    });
    if (user && !user.isGuest) return { personId: user.id, guest: false };
  } catch (err) {
    console.error('Error looking up who talked to a bot:', err);
    // Nothing was learned: the bot server's own word stands, never a guess that they are a guest
    return { personId: null, guest: typeof isGuest === 'boolean' ? isGuest : null };
  }
  return { personId: null, guest: true };
}
