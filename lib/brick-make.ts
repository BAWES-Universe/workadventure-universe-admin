import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { createBrick } from '@/lib/brick-create';
import { ownsBrick } from '@/lib/brick';
import { CARD_SELECT, DEFAULT_BRICK_LOOK, listBricks, toCard, type BrickCard } from '@/lib/brick-default';
import { BrickRequestKeyUsed, NewBricksLimit, NEW_BRICKS_LIMIT_CODE, claimNewBrick, lockNewBricks, newBricksRefusal } from '@/lib/brick-new-limit';
import { findUserByIdentifier } from '@/lib/user-identifier';

/**
 * More Bricks (game #1996). A person makes another Brick in two ways, and both end here: New Brick on their Bricks page
 * (the game's own form), and asking their Brick in their own chat with it ("make me a bot that keeps my mum's
 * recipes"), where the bot server asks for them. Either way the new Brick is theirs, has no room, and runs on Universe
 * AI, drawing on the same replies as every other bot they talk to: making Bricks gives nobody a second allowance
 * (lib/reply-limits.ts counts a person's Universe AI replies across all bots).
 */

/**
 * The Brick looks, in the order a new Brick tries them: the orange one is the Brick everyone gets, so a Brick made from
 * chat starts at the next colour its owner has not used yet. The game draws each look from its id.
 */
export const BRICK_LOOKS = [
  DEFAULT_BRICK_LOOK,
  'brick-red',
  'brick-amber',
  'brick-lime',
  'brick-green',
  'brick-teal',
  'brick-sky',
  'brick-blue',
  'brick-violet',
  'brick-pink',
  'brick-white',
  'brick-charcoal',
] as const;

/** What can be said about a new Brick. Its owner, its key and its room are never read from here. */
export const newBrickSchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be empty').max(100, 'name must be at most 100 characters'),
    /** Its one line on the Bricks page ("Keeps the family recipes"). */
    description: z.string().trim().max(200, 'description must be at most 200 characters').nullish(),
    /** What it is told to be like and to do. */
    chatInstructions: z.string().nullish(),
    /** Its look: a Brick look or a WOKA the game offers. None: the next Brick colour its owner has not used. */
    characterTextureId: z.string().trim().min(1).max(100, 'characterTextureId must be at most 100 characters').nullish(),
    /** The first line of its chat while nothing is written there. None: the game's own. */
    hello: z.string().trim().max(300, 'hello must be at most 300 characters').nullish(),
  })
  .strict();
export type NewBrickInput = z.infer<typeof newBrickSchema>;

/** The first Brick colour none of this person's Bricks wears; when all are worn, the one worn least. */
function nextLook(worn: (string | null)[]): string {
  const count = new Map<string, number>(BRICK_LOOKS.map((look) => [look, 0]));
  for (const look of worn) if (look && count.has(look)) count.set(look, count.get(look)! + 1);
  let best: string = BRICK_LOOKS[0];
  for (const look of BRICK_LOOKS) if (count.get(look)! < count.get(best)!) best = look;
  return best;
}

/** New Brick from the game's own form: the same, with a key that makes a repeat of the request the same Brick. */
export const newBrickRequestSchema = newBrickSchema.extend({ requestKey: z.string().trim().min(1, 'requestKey must not be empty').max(200, 'requestKey must be at most 200 characters').nullish() }).strict();

/**
 * Makes a Brick for this person, or says why not. It is where every way of making one meets "New Bricks per hour"
 * (lib/brick-new-limit.ts): a person over the limit makes nothing and gets NewBricksLimit, whichever way they asked.
 *
 * With a `requestKey`, a repeat of the same request answers the Brick it first made (`created` false) instead of making
 * another, and is never counted twice: also two at once, because the person's make lock lets one go first and the other
 * then finds its Brick. A key that comes back with another name, or for a Brick since deleted, is refused (BrickRequestKeyUsed).
 */
export async function makeBrickOnce(
  ownerId: string,
  input: NewBrickInput,
  db: Prisma.TransactionClient = prisma,
  requestKey?: string | null,
  /** The limit as the caller read it before its transaction opened; read here when the caller has not. */
  newPerHour?: number,
): Promise<{ brick: BrickCard; created: boolean }> {
  // Read before any transaction holds a connection: a caller whose transaction is open has the limit already
  const limit = newPerHour ?? (await getBrickLimits()).newPerHour;
  // Counted and written under one lock, or two makes at once could both slip in under the limit
  if ((db as unknown) === prisma) return prisma.$transaction((tx) => makeBrickOnce(ownerId, input, tx, requestKey, limit));
  await lockNewBricks(db, ownerId);
  if (requestKey) {
    const first = await db.bot.findFirst({ where: { ownerId, createRequestKey: requestKey }, select: { ...CARD_SELECT, deletedAt: true, createRequestName: true } });
    if (first) {
      // The name that request asked for, not the Brick's name now: the owner may have renamed it since
      if (first.deletedAt !== null || (first.createRequestName ?? first.name) !== input.name) throw new BrickRequestKeyUsed();
      return { brick: toCard(first, false), created: false };
    }
  }
  await claimNewBrick(db, ownerId, limit);
  const look =
    input.characterTextureId ??
    nextLook((await db.bot.findMany({ where: { ownerId, roomId: null, deletedAt: null }, select: { characterTextureId: true } })).map((bot) => bot.characterTextureId));
  const bot = await createBrick({
    ownerId,
    name: input.name,
    description: input.description || null,
    characterTextureId: look,
    chatInstructions: input.chatInstructions?.trim() || null,
    hello: input.hello || null,
    createRequestKey: requestKey ?? null,
  }, db);
  return { brick: toCard(bot, false), created: true };
}

/** Makes a Brick for this person and answers with its card. Throws NewBricksLimit when they have made too many this hour. */
export async function makeBrick(ownerId: string, input: NewBrickInput, db: Prisma.TransactionClient = prisma, newPerHour?: number): Promise<BrickCard> {
  return (await makeBrickOnce(ownerId, input, db, undefined, newPerHour)).brick;
}

/** What the bot server sends when a person asks their Brick for another one. */
export const chatBrickSchema = newBrickSchema
  .extend({
    /** Who asked, as the bot server names people: their game uuid, or their email. */
    userId: z.string().trim().min(1).max(320),
    /** Make it even though this person already has a Brick of that name: they asked for a second one on purpose. */
    evenIfThere: z.boolean().optional(),
  })
  .strict();

export type ChatBrickAnswer =
  | { ok: true; made: boolean; brick: BrickCard; bricks: BrickCard[] }
  | { ok: false; status: 403 | 404 | 409; error: string }
  /** Over "New Bricks per hour": nothing was made. `error` is the kind line, in the person's own clock. */
  | { ok: false; status: 429; error: string; code: typeof NEW_BRICKS_LIMIT_CODE; retryAt: string; retryAfterSeconds: number };

/**
 * The owner of the Brick that asks, when `userId` is that owner: a signed-in person, found by the name the bot server
 * knows them by. Null for anyone else, so a Brick only ever acts on Bricks for the person it belongs to.
 */
export async function ownerAskingThrough(viaBrickId: string, userId: string): Promise<string | null> {
  const [via, person] = await Promise.all([
    prisma.bot.findUnique({ where: { id: viaBrickId }, select: { roomId: true, ownerId: true, deletedAt: true } }),
    findUserByIdentifier(userId),
  ]);
  if (!via || !person || person.isGuest) return null;
  return ownsBrick(via, person.id) ? person.id : null;
}

/**
 * A person asks their Brick, in their own chat with it, for another Brick. Only the owner of the Brick that asks gets
 * one. A Brick of that name they already have is answered instead of making a second (`made: false`), unless they asked
 * for a second one on purpose. The answer also lists their Bricks, so the asking Brick can say which chat to open.
 */
export async function makeBrickFromChat(viaBrickId: string, input: z.infer<typeof chatBrickSchema>): Promise<ChatBrickAnswer> {
  const { userId, evenIfThere, ...brick } = input;
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return { ok: false, status: 404, error: 'Brick not found' };
  // Read before the transaction holds a connection (see claimNewBrick)
  const { newPerHour } = await getBrickLimits();
  // One at a time per person and name (a lock held for the transaction): two asks for the same name that arrive
  // together would otherwise each find no such Brick and each make one.
  const lookOrMake = () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brick-make:${ownerId}:${brick.name.toLowerCase()}`}))`;
      if (!evenIfThere) {
        const there = await tx.bot.findFirst({
          where: { ownerId, roomId: null, deletedAt: null, name: { equals: brick.name, mode: 'insensitive' } },
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (there) return { made: false as const, id: there.id };
      }
      return { made: true as const, brick: await makeBrick(ownerId, brick, tx, newPerHour) };
    });
  try {
    // A Brick found can be deleted before the list is read: then the look is made again under the same lock, so two asks that both lost it
    // find the one the first of them makes, and never make two
    for (let attempt = 0; ; attempt++) {
      const outcome = await lookOrMake();
      const bricks = await listBricks(ownerId);
      if (outcome.made) return { ok: true, made: true, brick: outcome.brick, bricks };
      const card = bricks.find((one) => one.id === outcome.id);
      if (card) return { ok: true, made: false, brick: card, bricks };
      // The one found was gone from the list again and again: no Brick is made outside the lock (two asks that both got here would each make one), so the
      // ask ends with an answer the caller can ask again after
      if (attempt >= 2) return { ok: false, status: 409, error: 'Your Bricks changed while this was being asked. Ask again.' };
    }
  } catch (error) {
    // Over "New Bricks per hour": nothing was made, and the Brick that asks says the kind line as it is
    if (error instanceof NewBricksLimit) {
      const refusal = await newBricksRefusal(ownerId, error);
      return { ok: false, status: 429, error: refusal.body.error, code: NEW_BRICKS_LIMIT_CODE, retryAt: refusal.body.retryAt, retryAfterSeconds: refusal.retryAfterSeconds };
    }
    throw error;
  }
}

/** This person's Bricks, for the Brick that asks on their behalf (so it can open one instead of making it twice). */
export async function bricksForChat(viaBrickId: string, userId: string): Promise<BrickCard[] | null> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  return ownerId ? listBricks(ownerId) : null;
}

