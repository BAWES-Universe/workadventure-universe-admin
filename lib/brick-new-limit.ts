import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { TIME_ZONE_KEY, isTimeZone } from '@/lib/brick-item-time';

/**
 * New Bricks per hour (default-brick design, quick create: DB-E9, DB-T5). One person can make this many new Bricks in an hour,
 * every way together: New Brick, Create Brick from a template and asking a Brick in chat. It exists so a script cannot flood
 * the system; nobody switches it on, and the number is the `newPerHour` Brick limit (30 until a super admin changes it).
 *
 * What counts: the person's own Bricks made in the last hour, deleted ones included (a deleted Brick's row stays for its Undo
 * days, so making and deleting cannot get round it). The Brick everyone gets first is not counted: it is made for them, not by
 * them. It counts Bricks made, never replies: Universe AI's fair usage and a person's own keys are not touched by it.
 */
export const NEW_BRICKS_WINDOW_MS = 60 * 60 * 1000;

/** The code Orbit answers a refused make with, so the game and the bot server can tell it from any other refusal. */
export const NEW_BRICKS_LIMIT_CODE = 'new_bricks_limit';

/** Thrown inside a transaction, so nothing is made. `retryAt` is the moment the person can make one again. */
export class NewBricksLimit extends Error {
  constructor(
    readonly retryAt: Date,
    readonly limit: number,
  ) {
    super('New Bricks per hour reached');
  }
}

/** The same request key came back for a different Brick, or for one that has since been deleted. */
export class BrickRequestKeyUsed extends Error {
  constructor() {
    super('That requestKey was already used for a different Brick. Send a new requestKey for a new request.');
  }
}

/** Holds the person's "making a Brick" lock until the caller's transaction ends, so two makes at once are counted one after the other. */
export async function lockNewBricks(tx: Prisma.TransactionClient, ownerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-new:${ownerId}`}))`;
}

/**
 * Makes room for one more new Brick for this person, inside the caller's transaction (which holds lockNewBricks), or throws
 * NewBricksLimit. `newPerHour` is read by the caller before its transaction opens: a read made inside it would need a second
 * connection while this one holds the person's lock, and a busy pool could then wait on itself. Said with the first moment a Brick can be made again: when enough of the hour's Bricks have aged out for the
 * count to be under the limit.
 */
export async function claimNewBrick(tx: Prisma.TransactionClient, ownerId: string, newPerHour: number, now: Date = new Date()): Promise<void> {
  const since = new Date(now.getTime() - NEW_BRICKS_WINDOW_MS);
  // Bricks only (they have an owner and no room); the one everyone gets first is not one the person made
  const counted = { ownerId, roomId: null, createdAt: { gt: since }, defaultBrickOf: null } satisfies Prisma.BotWhereInput;
  const made = await tx.bot.count({ where: counted });
  if (made < newPerHour) return;
  // The oldest `made - newPerHour + 1` of them must leave the hour before there is room again: the last of those sets the time
  const [blocking] = await tx.bot.findMany({ where: counted, select: { createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: made - newPerHour, take: 1 });
  const first = blocking?.createdAt ?? now;
  throw new NewBricksLimit(new Date(first.getTime() + NEW_BRICKS_WINDOW_MS), newPerHour);
}

/**
 * The kind line a person reads when they are over. With a time zone saved for them it says the real clock time ("Try again at
 * 3:40 PM"); with none it says the minutes, never a time on a clock they did not tell us.
 */
export function newBricksLine(retryAt: Date, timeZone: string | null, now: Date = new Date()): string {
  const lead = "You've made a lot of Bricks this hour.";
  if (timeZone && isTimeZone(timeZone)) {
    // Newer runtimes put a narrow no-break space before AM/PM; a plain space reads the same and copies cleanly
    // Up to the next whole minute: "3:40 PM" for 3:40:59 would be a minute early, and a try inside it would be refused again
    const shown = new Date(Math.ceil(retryAt.getTime() / 60_000) * 60_000);
    const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(shown).replace(/[\u202f\u00a0]/g, ' ');
    return `${lead} Try again at ${at}.`;
  }
  const minutes = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
  return `${lead} Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
}

/** What to answer when a make is refused for the hour: 429, the kind line in the person's own clock, and `retryAt` for a caller that formats it itself. */
export async function newBricksRefusal(ownerId: string, refused: NewBricksLimit, now: Date = new Date()) {
  const saved = await prisma.userPreference.findUnique({ where: { userId_key: { userId: ownerId, key: TIME_ZONE_KEY } }, select: { value: true } }).catch(() => null);
  const zone = typeof saved?.value === 'string' ? saved.value : null;
  return {
    status: 429 as const,
    retryAfterSeconds: Math.max(1, Math.ceil((refused.retryAt.getTime() - now.getTime()) / 1000)),
    body: { error: newBricksLine(refused.retryAt, zone, now), code: NEW_BRICKS_LIMIT_CODE, retryAt: refused.retryAt.toISOString(), limit: refused.limit },
  };
}
