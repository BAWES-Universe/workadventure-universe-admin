import { z } from 'zod';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { ownsBrick } from '@/lib/brick';
import { DEFAULT_BRICK_LOOK, listBricks, toCard, type BrickCard } from '@/lib/brick-default';
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

/** Makes a Brick for this person and answers with its card. */
export async function makeBrick(ownerId: string, input: NewBrickInput): Promise<BrickCard> {
  const look =
    input.characterTextureId ??
    nextLook((await prisma.bot.findMany({ where: { ownerId, roomId: null, deletedAt: null }, select: { characterTextureId: true } })).map((bot) => bot.characterTextureId));
  const bot = await createBrick({
    ownerId,
    name: input.name,
    description: input.description || null,
    characterTextureId: look,
    chatInstructions: input.chatInstructions?.trim() || null,
    hello: input.hello || null,
  });
  return toCard(bot, false);
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
  | { ok: false; status: 403 | 404; error: string };

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
  if (!evenIfThere) {
    const there = await prisma.bot.findFirst({
      where: { ownerId, roomId: null, deletedAt: null, name: { equals: brick.name, mode: 'insensitive' } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (there) {
      const bricks = await listBricks(ownerId);
      const card = bricks.find((one) => one.id === there.id);
      if (card) return { ok: true, made: false, brick: card, bricks };
    }
  }
  const made = await makeBrick(ownerId, brick);
  return { ok: true, made: true, brick: made, bricks: await listBricks(ownerId) };
}

/** This person's Bricks, for the Brick that asks on their behalf (so it can open one instead of making it twice). */
export async function bricksForChat(viaBrickId: string, userId: string): Promise<BrickCard[] | null> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  return ownerId ? listBricks(ownerId) : null;
}

