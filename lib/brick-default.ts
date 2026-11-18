import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';

/**
 * The Brick every signed-in person gets (game #1995): one Brick, on Universe AI, made once per account.
 *
 * "Once" is the account's row in `default_bricks`. Whoever writes that row makes the Brick, in the same transaction, and
 * everyone else finds the row: a second device, a double tap and a later sign-in make nothing. The row stays when the
 * Brick is deleted, so a Brick its owner deleted on purpose is never made again: not while it waits for Undo (game
 * #1996), and not after it is gone for good.
 *
 * Making it sends nothing to anyone: no message, no notice, no unread count. Its hello is fixed text the game shows when
 * the chat is opened, and no AI runs until its owner writes to it.
 *
 * It gives nobody a second allowance: Universe AI replies are counted per person across every bot on Universe AI (see
 * reply-limits.ts), so this Brick draws on the same replies as any other bot the person talks to.
 */

/** What the Brick everyone gets starts as. Its owner can rename it; the game draws the look. */
export const DEFAULT_BRICK_NAME = 'Brick';
export const DEFAULT_BRICK_DESCRIPTION = 'Your everyday helper';
/** The look of a person's own Brick: the orange brick. The game draws a Brick's look from this id. */
export const DEFAULT_BRICK_LOOK = 'brick-orange';

/** A Brick as its owner's Bricks page and chats need it: nothing that steers it, and nothing about what it runs on. */
export interface BrickCard {
  id: string;
  name: string;
  description: string | null;
  characterTextureId: string | null;
  enabled: boolean;
  /** The Brick this account got by itself, as opposed to one its owner made. */
  isDefault: boolean;
  /**
   * The first line of its chat while nothing is written there, for a Brick that was made for a job (game #1996). Null:
   * the game shows its own fixed hello.
   */
  hello: string | null;
  createdAt: string;
}

/** A Brick its owner deleted, while Undo can still give it back (game #1996). */
export interface DeletedBrickCard extends BrickCard {
  deletedAt: string;
  /** When it is gone for good. Undo works until then. */
  goneAt: string;
}

export type BrickRow = {
  id: string;
  name: string;
  description: string | null;
  characterTextureId: string | null;
  enabled: boolean;
  hello: string | null;
  createdAt: Date;
};

export const CARD_SELECT = { id: true, name: true, description: true, characterTextureId: true, enabled: true, hello: true, createdAt: true } as const;

export function toCard(bot: BrickRow, isDefault: boolean): BrickCard {
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    characterTextureId: bot.characterTextureId,
    enabled: bot.enabled,
    isDefault,
    hello: bot.hello,
    createdAt: bot.createdAt.toISOString(),
  };
}

export type DefaultBrickAnswer =
  /** The account's Brick. `made` is true only for the one request that made it. */
  | { brick: BrickCard; made: boolean; deleted: false }
  /** Its owner deleted it on purpose: it is not made again. */
  | { brick: null; made: false; deleted: true };

/**
 * The account's own Brick, made now when this account never had one. Safe to ask as often as the game likes, and from
 * as many devices at once: the database lets one request write the account's row, and the others wait for it and then
 * read the same Brick.
 */
export async function ensureDefaultBrick(userId: string): Promise<DefaultBrickAnswer> {
  return prisma.$transaction(async (tx) => {
    // One statement decides who makes the Brick. A request that comes while another holds the row waits here until
    // that one is done, then finds the row and writes nothing.
    const claimed = await tx.$queryRaw<{ user_id: string }[]>(Prisma.sql`
      INSERT INTO "default_bricks" ("user_id") VALUES (${userId})
      ON CONFLICT ("user_id") DO NOTHING
      RETURNING "user_id"`);
    if (claimed.length === 0) {
      const row = await tx.defaultBrick.findUnique({ where: { userId }, select: { bot: { select: { ...CARD_SELECT, deletedAt: true } } } });
      // Deleted is deleted from the moment its owner said so: while it waits for Undo it is not handed out either
      if (row?.bot && row.bot.deletedAt === null) return { brick: toCard(row.bot, true), made: false, deleted: false };
      return { brick: null, made: false, deleted: true };
    }
    const bot = await createBrick(
      { ownerId: userId, name: DEFAULT_BRICK_NAME, description: DEFAULT_BRICK_DESCRIPTION, characterTextureId: DEFAULT_BRICK_LOOK },
      tx,
    );
    await tx.defaultBrick.update({ where: { userId }, data: { botId: bot.id } });
    return { brick: toCard(bot, true), made: true, deleted: false };
  });
}

/**
 * A person's Bricks for their Bricks page: the one everyone gets first, then the ones they made, oldest first. Only
 * their own: a Brick is nobody else's to list, a super admin included. A Brick that waits deleted is not one of them
 * (see listDeletedBricks).
 */
export async function listBricks(userId: string): Promise<BrickCard[]> {
  const [bots, own] = await Promise.all([
    prisma.bot.findMany({ where: { ownerId: userId, roomId: null, deletedAt: null }, select: CARD_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.defaultBrick.findUnique({ where: { userId }, select: { botId: true } }),
  ]);
  const cards = bots.map((bot) => toCard(bot, bot.id === own?.botId));
  return [...cards.filter((card) => card.isDefault), ...cards.filter((card) => !card.isDefault)];
}

/**
 * The Bricks this person deleted that Undo can still give back (game #1996), the last one deleted first. One whose time
 * has passed is not listed, whether or not its row has been removed yet.
 */
export async function listDeletedBricks(userId: string, now: Date = new Date()): Promise<DeletedBrickCard[]> {
  const [bots, own] = await Promise.all([
    prisma.bot.findMany({
      where: { ownerId: userId, roomId: null, deletedAt: { not: null }, goneAt: { gt: now } },
      select: { ...CARD_SELECT, deletedAt: true, goneAt: true },
      orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.defaultBrick.findUnique({ where: { userId }, select: { botId: true } }),
  ]);
  return bots.map((bot) => ({ ...toCard(bot, bot.id === own?.botId), deletedAt: bot.deletedAt!.toISOString(), goneAt: bot.goneAt!.toISOString() }));
}

/** Whether this bot is the Brick its owner's account got by itself. */
export async function isDefaultBrick(botId: string): Promise<boolean> {
  return (await prisma.defaultBrick.count({ where: { botId } })) > 0;
}
