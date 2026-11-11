import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { parsePlayUri } from '@/lib/utils';
import { windowStart } from '@/lib/reply-limits';
import { FAIR_USAGE_WINDOW_HOURS } from '@/lib/bot-limit-values';
import { getBrickLimits, getServerLimits, servedLimits } from '@/lib/bot-limits';
import { providerPayload } from '@/lib/ai-provider-payload';
import { UNIVERSE_AI_MISSING, resolveUniverseAiProvider } from '@/lib/universe-ai';
import { DEFAULT_BRICK_LOOK, DEFAULT_BRICK_NAME, ensureDefaultBrick } from '@/lib/brick-default';

/**
 * The Brick for guests (game #1997): a guest opens Chats and finds a Brick that helps with this place, and keeps the chat
 * after signing in.
 *
 * It is Universe's own, like the Chats panel or Help. Every universe has it and no host has a switch for it. It is one
 * definition that is shared, not a bot made for each guest: it has no bot row, so nothing is created for a guest, and
 * nothing it does is read by a host's pages, a host's key or a host bot's guest pool. What this file keeps is totals:
 * who (the guest's id), where (the universe), when and what a reply took. Never what was said.
 *
 * Its hello is fixed text in the game and never a model call. It never messages first. A model runs only when the
 * guest's own message asks for a reply, and each of those goes through `claimGuestBrickReply` first.
 */

/** A request this file turned down, with the status the route answers. */
export class GuestBrickError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) {
    super(message);
  }
}

/** Where a reply is counted when the room is in no universe Orbit knows. */
export const OUTSIDE_UNIVERSE = 'outside';

/** What the Brick for guests is. The look is the one every Brick starts with; the game draws it and says its hello. */
export const GUEST_BRICK = {
  name: DEFAULT_BRICK_NAME,
  description: 'A helper for this place',
  characterTextureId: DEFAULT_BRICK_LOOK,
  /**
   * What steers it. It helps with this place and says plainly what needs an account, in one short sentence and once.
   * It knows nothing of other people here, and nothing about distances or who is nearest.
   */
  chatInstructions: [
    'You are Brick, a helper in Universe. The person you are talking to is a guest and has not signed in.',
    'Help them with this place: answer questions about it using only the details you are given below, show them around and say what a Brick is in a sentence or two. Keep every answer short and in plain words.',
    'If you do not know something about this place, say you are not sure. Never guess.',
    'You cannot remember anything after this visit, keep what you make, work with apps, make more Bricks or use a computer. Those come once they sign in and you become theirs. Answer in the spirit of: "I can only remember things once I\'m yours."',
    'When they ask for one of those, say so in one short sentence and say that this chat comes along when they sign in. Say it once and do not repeat it.',
    'Never talk about other people in this place, and never say who or what is near or nearest.',
  ].join('\n'),
} as const;

/** Where a guest is, as much as the Brick may say about it: the names and descriptions the guest already sees. */
export interface GuestPlace {
  /** The universe's id, or "outside" for a room that is in no universe Orbit knows. */
  universeKey: string;
  universe: { name: string; description: string | null } | null;
  world: { name: string; description: string | null } | null;
  room: { name: string; description: string | null } | null;
  /** The same, as lines the bot server adds to what steers the Brick. Empty when nothing is known. */
  text: string;
}

const line = (label: string, item: { name: string; description: string | null } | null) =>
  item ? `${label}: ${item.name}${item.description ? ` (${item.description.replace(/\s+/g, ' ').trim().slice(0, 500)})` : ''}` : null;

/**
 * The place the guest is in, from the address of their room. Only what the guest can already see by being there: the
 * names and descriptions of its universe, world and room. Nothing a room restricts, and nothing about other people.
 */
export async function placeFor(roomUrl: unknown): Promise<GuestPlace> {
  const none: GuestPlace = { universeKey: OUTSIDE_UNIVERSE, universe: null, world: null, room: null, text: '' };
  if (typeof roomUrl !== 'string' || !roomUrl) return none;
  let parsed: ReturnType<typeof parsePlayUri>;
  try {
    parsed = parsePlayUri(roomUrl);
  } catch {
    return none;
  }
  const universe = await prisma.universe.findUnique({ where: { slug: parsed.universe }, select: { id: true, name: true, description: true } });
  if (!universe) return none;
  const world = await prisma.world.findFirst({ where: { universeId: universe.id, slug: parsed.world }, select: { id: true, name: true, description: true } });
  const room = world ? await prisma.room.findFirst({ where: { worldId: world.id, slug: parsed.room }, select: { name: true, description: true } }) : null;
  const place = {
    universeKey: universe.id,
    universe: { name: universe.name, description: universe.description },
    world: world ? { name: world.name, description: world.description } : null,
    room: room ? { name: room.name, description: room.description } : null,
  };
  const text = [line('Universe', place.universe), line('World', place.world), line('Room', place.room)].filter(Boolean).join('\n');
  return { ...place, text };
}

/**
 * How the Brick for guests talks to its AI. It runs on Universe AI, which Universe pays for: never a host's key and never
 * a host bot's. The limits are Universe AI's, like any bot on it.
 */
export async function guestBrickCredentials() {
  const provider = await resolveUniverseAiProvider();
  if (!provider) throw new GuestBrickError(UNIVERSE_AI_MISSING, 503);
  const server = await getServerLimits();
  const limits = servedLimits(server.universeAi, server, {});
  return { ...providerPayload(provider), source: 'universe-ai' as const, maxTokens: limits.replyTokens, limits };
}

/** What the bot server reads to run the Brick for guests in a room. */
export async function guestBrickFor(roomUrl: unknown) {
  const [place, credentials] = await Promise.all([placeFor(roomUrl), guestBrickCredentials()]);
  return {
    brick: { ...GUEST_BRICK, chatInstructions: place.text ? `${GUEST_BRICK.chatInstructions}\n\nThis place:\n${place.text}` : GUEST_BRICK.chatInstructions },
    place: { universeKey: place.universeKey, universe: place.universe, world: place.world, room: place.room },
    credentials,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Its own allowance
// ---------------------------------------------------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

export type GuestBrickAllowance =
  /** `counted` is false when this very turn was already counted: a retry costs nothing. */
  | { allowed: true; turnId: string; counted: boolean }
  /** `limit` says which one stopped it: the guest's own allowance, or the universe's pool for guests. */
  | { allowed: false; limit: 'guest' | 'universe'; resetsAt: string };

const idOf = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new GuestBrickError(`${name} is required`, 400);
  return value.trim().slice(0, 255);
};

/**
 * May this guest get one more reply from the Brick for guests now, and if so, count it. Asked by the bot server before
 * each model call, never for the hello and never for anything the Brick says on its own (it says nothing on its own).
 *
 * Two allowances, both super admin settings (Limits, Bricks), both counted only here:
 *   - the guest's own, across every universe;
 *   - the universe's pool for all its guests.
 * A window starts at the first reply asked for once the last one has ended, as for every Universe AI allowance.
 * The answer is `allowed` for exactly the replies that fit, however many come at once: the two counts and the write
 * happen while holding the guest's and the universe's locks. The same turn asked again is counted once.
 */
export async function claimGuestBrickReply(input: { guestId?: unknown; turnId?: unknown; roomUrl?: unknown }, now: Date = new Date()): Promise<GuestBrickAllowance> {
  const guestKey = idOf(input.guestId, 'guestId');
  const turnId = idOf(input.turnId, 'turnId');
  const [{ universeKey }, limits] = await Promise.all([placeFor(input.roomUrl), getBrickLimits()]);

  const [guestSince, poolSince] = await Promise.all([
    windowStart(`gb:guest:${guestKey}`, FAIR_USAGE_WINDOW_HOURS, now),
    windowStart(`gb:pool:${universeKey}`, FAIR_USAGE_WINDOW_HOURS, now),
  ]);
  const ends = (since: Date) => new Date(since.getTime() + FAIR_USAGE_WINDOW_HOURS * HOUR).toISOString();

  return prisma.$transaction(async (tx) => {
    // Always the guest's lock first, then the universe's: two claims never wait on each other in a circle
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`gb:guest:${guestKey}`}))`);
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`gb:pool:${universeKey}`}))`);

    const same = await tx.guestBrickReply.findUnique({ where: { turnId }, select: { guestKey: true, failed: true } });
    if (same && same.guestKey !== guestKey) throw new GuestBrickError('turnId belongs to another guest', 409);
    if (same && !same.failed) return { allowed: true, turnId, counted: false };

    const [guestUsed, poolUsed] = await Promise.all([
      tx.guestBrickReply.count({ where: { guestKey, failed: false, createdAt: { gte: guestSince } } }),
      tx.guestBrickReply.count({ where: { universeKey, failed: false, createdAt: { gte: poolSince } } }),
    ]);
    if (guestUsed >= limits.guestReplies) return { allowed: false, limit: 'guest', resetsAt: ends(guestSince) };
    if (poolUsed >= limits.universePool) return { allowed: false, limit: 'universe', resetsAt: ends(poolSince) };

    // Never earlier than the window it is counted in: a request that read the clock before another one opened it
    const at = new Date(Math.max(now.getTime(), guestSince.getTime(), poolSince.getTime()));
    await tx.guestBrickReply.upsert({
      where: { turnId },
      create: { turnId, guestKey, universeKey, createdAt: at },
      update: { failed: false, createdAt: at },
    });
    return { allowed: true, turnId, counted: true };
  });
}

/**
 * Closes one counted turn. A reply that failed is given back: it stops counting, so a guest is never charged an allowance
 * for an answer they did not get. What it took is kept as a total, with no content.
 */
export async function finishGuestBrickReply(turnIdInput: unknown, input: { failed?: unknown; tokensUsed?: unknown; costMicros?: unknown }): Promise<{ turnId: string; failed: boolean }> {
  const turnId = idOf(turnIdInput, 'turnId');
  const whole = (value: unknown, name: string): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_000_000_000) throw new GuestBrickError(`${name} must be a whole number from 0`, 400);
    return value;
  };
  if (input.failed !== undefined && typeof input.failed !== 'boolean') throw new GuestBrickError('failed must be true or false', 400);
  const tokensUsed = whole(input.tokensUsed, 'tokensUsed');
  const costMicros = whole(input.costMicros, 'costMicros');
  const failed = input.failed === true;
  const done = await prisma.guestBrickReply.updateMany({
    where: { turnId },
    data: { failed, ...(tokensUsed !== null ? { tokensUsed } : {}), ...(costMicros !== null ? { costMicros } : {}) },
  });
  if (done.count === 0) throw new GuestBrickError('Reply not found', 404);
  return { turnId, failed };
}

// ---------------------------------------------------------------------------------------------------------------------
// Signing in: the chat goes to one account, once
// ---------------------------------------------------------------------------------------------------------------------

/** How long a guest's chat can still be handed to an account: as long as a guest's files stay (Limits, Files in chats). */
async function handoverWindow(now: Date): Promise<Date> {
  const { files } = await getServerLimits();
  return new Date(now.getTime() - files.guestDays * 24 * HOUR);
}

/**
 * A guest signed in, and the game says (having checked it itself) the guest id this device used before. When that guest
 * talked to the Brick for guests within the window, the chat goes to this account:
 *   - the account's one Brick is made if it has none, by the same call that makes it everywhere else (`ensureDefaultBrick`),
 *     so there is never a second Brick;
 *   - the guest id is claimed in one statement, so the chat goes to one account once: another tab, a second sign-in and a
 *     different account find it claimed and take nothing.
 * A person who deleted their Brick on purpose gets none made and nothing handed over. A guest who never signs in leaves
 * nothing here but totals.
 */
export async function adoptGuestChat(guestId: string, userId: string, now: Date = new Date()): Promise<{ adopted: boolean }> {
  const since = await handoverWindow(now);
  // Another account's own id is never a guest's to hand over
  if (await prisma.user.findUnique({ where: { uuid: guestId }, select: { id: true } })) return { adopted: false };
  if (await prisma.guestBrickHandover.findUnique({ where: { guestKey: guestId }, select: { guestKey: true } })) return { adopted: false };
  const talked = await prisma.guestBrickReply.count({ where: { guestKey: guestId, failed: false, createdAt: { gte: since } } });
  if (talked === 0) return { adopted: false };

  const own = await ensureDefaultBrick(userId);
  if (own.deleted) return { adopted: false };

  const claimed = await prisma.$queryRaw<{ guest_key: string }[]>(Prisma.sql`
    INSERT INTO "guest_brick_handovers" ("guest_key", "user_id", "claimed_at") VALUES (${guestId}, ${userId}, ${now})
    ON CONFLICT ("guest_key") DO NOTHING
    RETURNING "guest_key"`);
  return { adopted: claimed.length > 0 };
}

/**
 * The device that was the guest picks its chat up (game #1997). It names the guest id it held; the chat is marked picked
 * up only for a hand-over of that guest id to this account, once. A device that was never that guest has no such id, so
 * it can never take it, and asking first, with no id or a wrong one, takes nothing. A chat nobody picked up within the
 * window is not given out.
 */
export async function takeCarriedGuestChat(userId: string, guestIdInput: unknown, now: Date = new Date()): Promise<{ carried: boolean }> {
  if (typeof guestIdInput !== 'string' || !guestIdInput.trim()) return { carried: false };
  const guestId = guestIdInput.trim().slice(0, 255);
  const since = await handoverWindow(now);
  const rows = await prisma.$queryRaw<{ guest_key: string }[]>(Prisma.sql`
    UPDATE "guest_brick_handovers" SET "carried_at" = ${now}
    WHERE "guest_key" = ${guestId} AND "user_id" = ${userId} AND "carried_at" IS NULL AND "claimed_at" >= ${since}
    RETURNING "guest_key"`);
  return { carried: rows.length > 0 };
}
