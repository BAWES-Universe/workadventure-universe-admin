/**
 * A Brick (game #1992): a bot that belongs to a person and has no room. It is the same bot as a room bot, with the same
 * id, settings and memory; the only difference is where it lives. A room bot lives in a room and is managed by the
 * room's people. A Brick lives in its owner's chats, and only its owner manages it and talks to it.
 *
 * Today's room bots are not Bricks and are never read as owned: `createdById` on a room bot only says who typed it in.
 * The database holds every bot to exactly one of the two, a room or an owner (the check `bots_room_or_owner`).
 *
 * Most of what a bot's page offers reads the bot's room: its universe's roles, lent keys and settings. Those parts
 * answer with `BRICK_HAS_NO_ROOM` for a Brick until the issue that opens each one for Bricks (game #1995 onwards) says
 * what it means without a room. Nothing a Brick has is ever decided by a room it is not in.
 */

/**
 * Where a bot lives, as stored: a room for a room bot, an owner for a Brick. `deletedAt` is set while a Brick its owner
 * deleted waits for Undo (game #1996). It is asked for by name, never optional, so that whoever decides something about
 * a Brick has to read it.
 */
export interface BotHome {
  roomId: string | null;
  ownerId: string | null;
  deletedAt: Date | null;
}

/** Whether this bot is a Brick: it has no room. */
export function isBrick(bot: { roomId: string | null }): boolean {
  return bot.roomId === null;
}

/**
 * Whether this person owns this Brick, and has it now. Always false for a room bot, whoever made it. False too for a
 * Brick that waits deleted: until its owner takes it back with Undo it is nobody's to chat with, read or change, so
 * everything that asks here stops for it at once. Only the Bricks page's own list, Undo and the last removal read a
 * deleted Brick, and they ask the database for it by name (lib/brick-delete.ts).
 */
export function ownsBrick(bot: BotHome, userId: string | null | undefined): boolean {
  return bot.roomId === null && bot.deletedAt === null && !!userId && bot.ownerId === userId;
}

/** What a part of a bot's page that needs a room says for a Brick, with a 404: there is no room to read. */
export const BRICK_HAS_NO_ROOM = 'This bot is not in a room';

/**
 * What such a part answers for a Brick, always with a 404. Its owner and the bot server are told why. To anyone else the
 * bot is not there at all, a super admin included: the same words as for a bot that does not exist.
 */
export function brickHasNoRoomText(bot: BotHome, reader: { userId?: string | null; isAdminToken?: boolean }): string {
  return reader.isAdminToken || ownsBrick(bot, reader.userId) ? BRICK_HAS_NO_ROOM : 'Bot not found';
}

/** The filter for lists that are about rooms and the people who run them: room bots only, never a Brick. */
export const ROOM_BOTS_ONLY = { roomId: { not: null } } as const;
