import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { checkKeyForOthers } from '@/lib/ai-key-pay';
import { ownsBrick } from '@/lib/brick';
import { listBricks, type BrickCard } from '@/lib/brick-default';
import { placeOfRoomId, placeOfRoomUrl } from '@/lib/brick-visit';
import { homeBehaviorConfig, resolvePlayUriFromRoomId } from '@/lib/bot-config-helpers';

/**
 * A Brick that lives in a room (game #2005, "Add one of your Bricks").
 *
 * A person who can manage bots in a room gives one of their own Bricks a home there. It then stands in the room for
 * everyone, like a room bot, and it stays their own Brick: the same bot, with the same chat and memory, no copy. It is a
 * row in `brick_homes` and nothing else: the Brick keeps no room of its own, so none of today's room bot code reads it.
 *
 * The rules.
 *   - A Brick has one home at most. Placing it again moves it.
 *   - Its owner can always take it out. So can the room's managers, who see the Bricks placed by others and can move
 *     them; they cannot read its owner's chat, change its personality or see its apps.
 *   - Taking it out, or deleting the room, returns it to its owner and deletes nothing of theirs: only the row goes.
 *   - It holds while the person who placed it can still manage bots in that room. One whose owner lost that is gone from
 *     the room (dropHomesWithoutAccess, also on every read).
 *   - For other people it follows the visit's rules (lib/brick-visit.ts, F4.1): they may chat with it by the room's roles
 *     and for nothing else, nothing of the owner's is used for them, and on the owner's own key they are served only
 *     where that key is lent to the room's universe. Where it is not lent, `placeBrick` says so with `keyNote`, so the
 *     sheet can tell the owner before it is placed.
 *   - A Brick that waits deleted or is switched off is not on the map; deleting a Brick withdraws its home and its visit.
 */

/** What a Brick's page says about its home. */
export interface HomeCard {
  roomUrl: string;
  roomName: string;
  universeName: string;
}

export type PlaceAnswer =
  | { ok: true; home: HomeCard; keyNote: 'not_lent' | null }
  | { ok: false; reason: 'not_found' | 'no_room' | 'no_access' };

export type HomeBehavior = { behaviorType?: 'idle' | 'patrol' | 'social'; behaviorConfig?: Record<string, unknown> };

async function homeCardOf(roomId: string): Promise<HomeCard | null> {
  const [place, room] = await Promise.all([
    placeOfRoomId(roomId),
    prisma.room.findUnique({ where: { id: roomId }, select: { name: true } }),
  ]);
  if (!place || !room) return null;
  return { roomUrl: await resolvePlayUriFromRoomId(roomId), roomName: room.name, universeName: place.name };
}

/**
 * The owner gives their Brick a home in the room, or moves it. The spot and how it behaves there come from the same
 * editor as any room bot's (`behaviorType`, `behaviorConfig`). Not found: it is not theirs, it waits deleted or it is a
 * room bot. No access: they cannot manage bots in that room.
 */
export async function placeBrick(input: { brickId: string; ownerId: string; roomUrl: string } & HomeBehavior): Promise<PlaceAnswer> {
  const brick = await prisma.bot.findUnique({ where: { id: input.brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, input.ownerId)) return { ok: false, reason: 'not_found' };
  const place = await placeOfRoomUrl(input.roomUrl);
  if (!place) return { ok: false, reason: 'no_room' };
  if (!(await canManageBots(input.ownerId, place.roomId))) return { ok: false, reason: 'no_access' };
  const data = { roomId: place.roomId, placedById: input.ownerId, behaviorType: input.behaviorType ?? 'idle', behaviorConfig: homeBehaviorConfig(input.behaviorConfig) as object };
  // The Brick's row is held while the home is written, as deleting it does: a Brick deleted a moment ago gets no home that
  // Undo would bring back. It stands in one place only, so a live visit of it ends here: placing it is the later word.
  const placed = await prisma.$transaction(async (tx) => {
    const held = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "bots" WHERE "id" = ${brick.id} AND "deleted_at" IS NULL AND "room_id" IS NULL FOR UPDATE`);
    if (held.length === 0) return false;
    await tx.brickVisit.deleteMany({ where: { botId: brick.id } });
    await tx.brickHome.upsert({ where: { botId: brick.id }, create: { botId: brick.id, ...data }, update: data });
    return true;
  });
  if (!placed) return { ok: false, reason: 'not_found' };
  const key = await checkKeyForOthers(brick.id, place.universeId);
  const card = await homeCardOf(place.roomId);
  return { ok: true, home: card!, keyNote: key.ok ? null : 'not_lent' };
}

/** The home as its owner's Brick page shows it, or null when it has none (or it no longer holds). */
export async function homeOfBrick(brickId: string, ownerId: string): Promise<HomeCard | null> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, ownerId)) return null;
  const home = await prisma.brickHome.findUnique({ where: { botId: brickId } });
  if (!home) return null;
  if (!(await canManageBots(home.placedById, home.roomId))) {
    // Only the row that failed the check: one moved to another room since is a newer placement
    await prisma.brickHome.deleteMany({ where: { botId: brickId, roomId: home.roomId, placedById: home.placedById } });
    return null;
  }
  return homeCardOf(home.roomId);
}

export type TakeOutAnswer = 'taken_out' | 'not_found';

/**
 * Take it out of its room: its owner, or a manager of that room. Only the home's row goes. Anyone else, and a Brick with
 * no home, is "not found", so the room's bots are not revealed. Asked twice, the second answer is the same.
 */
export async function takeOutBrick(brickId: string, actorId: string): Promise<TakeOutAnswer> {
  const home = await prisma.brickHome.findUnique({ where: { botId: brickId }, select: { roomId: true, bot: { select: { ownerId: true } } } });
  if (!home) {
    // The owner asking twice gets the same answer; anybody else learns nothing
    const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
    return brick && ownsBrick(brick, actorId) ? 'taken_out' : 'not_found';
  }
  const byOwner = home.bot.ownerId === actorId;
  if (!byOwner && !(await canManageBots(actorId, home.roomId))) return 'not_found';
  // A manager's removal is for the room they were checked in: if its owner has moved it elsewhere since, they take out nothing
  const removed = await prisma.brickHome.deleteMany({ where: byOwner ? { botId: brickId } : { botId: brickId, roomId: home.roomId } });
  return byOwner || removed.count > 0 ? 'taken_out' : 'not_found';
}

/**
 * A manager moves a Brick that already has a home in their room (its spot, radius, roaming, routes). They cannot place
 * one: only its owner does. Null when there is nothing of that kind in a room they manage.
 */
export async function moveBrick(brickId: string, actorId: string, behavior: HomeBehavior): Promise<boolean> {
  const home = await prisma.brickHome.findUnique({ where: { botId: brickId }, select: { roomId: true } });
  if (!home || !(await canManageBots(actorId, home.roomId))) return false;
  // The home's row is held while its settings are read, merged and written, so two edits of different keys both stay; and
  // only the room the manager was checked in is written, so a Brick its owner has moved since is left as it is
  return prisma.$transaction(async (tx) => {
    const held = await tx.$queryRaw<{ behavior_config: unknown }[]>(Prisma.sql`SELECT "behavior_config" FROM "brick_homes" WHERE "bot_id" = ${brickId} AND "room_id" = ${home.roomId} FOR UPDATE`);
    if (held.length === 0) return false;
    // Only the keys sent change: a body that says only how it walks up to people keeps its spot and route
    const behaviorConfig = behavior.behaviorConfig ? { ...homeBehaviorConfig(held[0].behavior_config), ...homeBehaviorConfig(behavior.behaviorConfig) } : undefined;
    await tx.brickHome.update({
      where: { botId: brickId },
      data: { ...(behavior.behaviorType ? { behaviorType: behavior.behaviorType } : {}), ...(behaviorConfig ? { behaviorConfig: behaviorConfig as object } : {}) },
    });
    return true;
  });
}

/** One row of the map editor's list of a room's Bricks. */
export interface RoomBrickRow {
  id: string;
  name: string;
  characterTextureId: string | null;
  /** Whose it is, by name only: people's emails are private. */
  ownerName: string | null;
  mine: boolean;
  /** Its owner and the room's managers may take it out. */
  canTakeOut: boolean;
  behaviorType: string;
  behaviorConfig: unknown;
  /** Since when it has lived here (the row's first day), for "here since 10 Nov". */
  since: string;
}

export interface RoomBricks {
  /** The room's name, for "It stands at a spot you choose in Headquarters". */
  roomName: string;
  /** The Bricks standing in this room. Those placed by others come after the viewer's own. */
  here: RoomBrickRow[];
  /** The viewer's own Bricks that can be placed here: every one of theirs that is on, and not at home in this room. */
  mine: (BrickCard & { homeElsewhere: boolean })[];
}

/**
 * What the map editor's list of a room's bots shows below today's list: the Bricks standing here, and "Add one of your
 * Bricks". Only for someone who can manage bots in the room; for anyone else, and for an address that is no room, null.
 */
export async function bricksOfRoom(roomUrl: string, viewerId: string): Promise<RoomBricks | null> {
  const place = await placeOfRoomUrl(roomUrl);
  if (!place || !(await canManageBots(viewerId, place.roomId))) return null;
  await dropHomesWithoutAccess(place.roomId);
  const homes = await prisma.brickHome.findMany({
    where: { roomId: place.roomId, bot: { enabled: true, deletedAt: null } },
    select: { botId: true, placedById: true, behaviorType: true, behaviorConfig: true, createdAt: true, bot: { select: { name: true, characterTextureId: true, ownerId: true, owner: { select: { name: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const rows: RoomBrickRow[] = homes.map((home) => ({
    id: home.botId,
    name: home.bot.name,
    characterTextureId: home.bot.characterTextureId,
    ownerName: home.bot.owner?.name ?? null,
    mine: home.bot.ownerId === viewerId,
    canTakeOut: true,
    behaviorType: home.behaviorType,
    behaviorConfig: homeBehaviorConfig(home.behaviorConfig),
    since: home.createdAt.toISOString(),
  }));
  const homesOf = new Map((await prisma.brickHome.findMany({ where: { placedById: viewerId }, select: { botId: true, roomId: true } })).map((home) => [home.botId, home.roomId]));
  const mine = (await listBricks(viewerId))
    .filter((card) => card.enabled && homesOf.get(card.id) !== place.roomId)
    .map((card) => ({ ...card, homeElsewhere: homesOf.has(card.id) }));
  const room = await prisma.room.findUnique({ where: { id: place.roomId }, select: { name: true } });
  return { roomName: room?.name ?? '', here: [...rows.filter((row) => row.mine), ...rows.filter((row) => !row.mine)], mine };
}

/**
 * Homes whose placer can no longer manage bots in the room go: "if its owner loses access to the universe, it leaves the
 * room". For one room, or for all of them (the sweep). The sweep reads every home, 200 at a time by Brick id, so a stale
 * home is never left behind a long run of healthy older ones; each person and room pair is asked once. Returns how many
 * went. The Bricks stay.
 */
export async function dropHomesWithoutAccess(roomId?: string, pageSize = 200): Promise<number> {
  const gone: { botId: string; roomId: string; placedById: string }[] = [];
  const memo = new Map<string, boolean>();
  let after: string | undefined;
  for (;;) {
    const homes = await prisma.brickHome.findMany({
      where: roomId ? { roomId } : {},
      select: { botId: true, roomId: true, placedById: true },
      take: pageSize,
      orderBy: { botId: 'asc' },
      ...(after ? { cursor: { botId: after }, skip: 1 } : {}),
    });
    for (const home of homes) {
      const key = `${home.placedById}:${home.roomId}`;
      if (!memo.has(key)) memo.set(key, await canManageBots(home.placedById, home.roomId));
      if (!memo.get(key)) gone.push({ botId: home.botId, roomId: home.roomId, placedById: home.placedById });
    }
    if (homes.length < pageSize) break;
    after = homes[homes.length - 1].botId;
  }
  if (gone.length === 0) return 0;
  // Each row that failed the check, as it was read: a home placed again since, in another room or by another person, stays
  let dropped = 0;
  for (let i = 0; i < gone.length; i += 200) dropped += (await prisma.brickHome.deleteMany({ where: { OR: gone.slice(i, i + 200) } })).count;
  return dropped;
}

/**
 * The Bricks that live in this room, for the bot server, in the Brick shape it knows plus `brick.home`. Only those that
 * are on and not deleted, and whose owner can still manage bots here.
 */
export async function homedBricksForRoom(roomUrl: string) {
  const place = await placeOfRoomUrl(roomUrl);
  if (!place) return [];
  await dropHomesWithoutAccess(place.roomId);
  return prisma.brickHome.findMany({
    where: { roomId: place.roomId, bot: { enabled: true, deletedAt: null, roomId: null } },
    select: {
      behaviorType: true,
      behaviorConfig: true,
      placedBy: { select: { uuid: true, name: true } },
      bot: {
        select: {
          id: true, name: true, ownerId: true, enabled: true, behaviorConfig: true, characterTextureId: true, createdAt: true, updatedAt: true,
          aiProviderRef: true, chatInstructions: true, toolTimeoutSeconds: true, maxReplyTokens: true, maxSteps: true, deletedAt: true,
        },
      },
    },
  });
}
