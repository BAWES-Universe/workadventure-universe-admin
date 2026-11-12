import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { mayReadRoomBots } from '@/lib/bot-room-access';
import { ownsBrick } from '@/lib/brick';
import { parsePlayUri } from '@/lib/utils';

/**
 * Bringing a Brick along (game #2005, "Bring along").
 *
 * A person's own Brick can walk beside them in any universe that takes visiting Bricks. It is the same Brick, with the
 * same id, memory and settings: a visit makes no second bot and no computer, and ending it removes only the visit's own
 * row (`brick_visits`). One Brick walks with a person at a time; bringing another swaps them.
 *
 * What a visit is. One row per person, which Brick, and where it was last seen. The bot server tells Orbit each time it
 * finds the person in a room (see `bricksForRoom`), so Orbit knows where a visit is without being told where people are.
 * A visit nobody has seen for a while ends by itself, which is how it ends when the person leaves Universe.
 *
 * Where a visit shows. Only where the universe takes visiting Bricks. Where it does not, the Brick is not on the map and
 * its page says so in one line; the visit is kept, and the Brick is on the map again where visits are taken. A Brick
 * still answers its owner in direct messages everywhere, whatever the universe says.
 *
 * What a visit never does. Nothing of the owner's is used for other people: no apps, files, computer or private memory.
 * A visiting Brick is never given a home, never roams and never greets. Who may talk to it, and on whose key it answers,
 * is decided in lib/bot-access.ts and lib/bot-ai-credentials.ts with `whereIsBrick`.
 */

const MINUTE_MS = 60 * 1000;

/** A room as a visit needs it: where it is, what its universe is called, and whether the universe takes visits. */
export interface Place {
  roomId: string;
  roomUrl: string;
  universeId: string;
  /** Said as "the place": the universe is what takes visiting Bricks, so it is what a Brick visits. */
  name: string;
  takesVisits: boolean;
  /** What `mayReadRoomBots` needs to say whether a person may see the room. */
  room: { isPublic: boolean; world: { id: string; universeId: string; isPublic: boolean; universe: { isPublic: boolean; ownerId: string } } };
}

const PLACE_SELECT = {
  id: true,
  isPublic: true,
  world: { select: { id: true, isPublic: true, universe: { select: { id: true, name: true, isPublic: true, ownerId: true, allowVisitingBricks: true } } } },
} satisfies Prisma.RoomSelect;

type PlaceRow = Prisma.RoomGetPayload<{ select: typeof PLACE_SELECT }>;

function toPlace(row: PlaceRow, roomUrl: string): Place {
  const { universe } = row.world;
  return {
    roomId: row.id,
    roomUrl,
    universeId: universe.id,
    name: universe.name,
    takesVisits: universe.allowVisitingBricks,
    room: { isPublic: row.isPublic, world: { id: row.world.id, universeId: universe.id, isPublic: row.world.isPublic, universe: { isPublic: universe.isPublic, ownerId: universe.ownerId } } },
  };
}

/** The room a play address names, or null for an address that is no room. */
export async function placeOfRoomUrl(roomUrl: string): Promise<Place | null> {
  let parsed: ReturnType<typeof parsePlayUri>;
  try {
    parsed = parsePlayUri(roomUrl);
  } catch {
    return null;
  }
  const row = await prisma.room.findFirst({
    where: { slug: parsed.room, world: { slug: parsed.world, universe: { slug: parsed.universe } } },
    select: PLACE_SELECT,
  });
  return row ? toPlace(row, roomUrl) : null;
}

/** The room by its id, for a visit or a home that is already stored. */
export async function placeOfRoomId(roomId: string): Promise<Omit<Place, 'roomUrl'> | null> {
  const row = await prisma.room.findUnique({ where: { id: roomId }, select: PLACE_SELECT });
  return row ? toPlace(row, '') : null;
}

/** How long a visit lasts without the bot server seeing its person: a super admin's number (Limits, "Bricks"). */
export async function visitEndsAfterMs(): Promise<number> {
  return (await getBrickLimits()).visitEndsMinutes * MINUTE_MS;
}

export type VisitState =
  /** Not visiting, and this place takes visiting Bricks: the page offers "Bring along". */
  | { state: 'none'; place: string | null }
  /** Visiting, and on the map here. */
  | { state: 'visiting'; place: string; startedAt: string }
  /**
   * This place does not take visiting Bricks, so the Brick is not on the map. `visiting` says whether a visit is kept for
   * the places that do. The page says it in one line, and direct messages still work.
   */
  | { state: 'blocked'; place: string; visiting: boolean };

/**
 * What a Brick's page says about visiting, for the person it belongs to and the room they are in (null: no room, then
 * the place its visit was last seen in). Only its owner asks: for any other Brick there is nothing to say.
 */
export async function visitState(brickId: string, ownerId: string, roomUrl: string | null, now: Date = new Date()): Promise<VisitState> {
  const visit = await liveVisit(ownerId, now);
  const mine = visit?.botId === brickId ? visit : null;
  let place: Pick<Place, 'name' | 'takesVisits'> | null = null;
  if (roomUrl) {
    const found = await placeOfRoomUrl(roomUrl);
    // A room the person may not see is not described to them: they only learn it is not somewhere Bricks visit
    if (found && (await mayReadRoomBots(found.room, ownerId))) place = found;
  } else if (mine?.roomId) {
    const found = await placeOfRoomId(mine.roomId);
    if (found) place = found;
  }
  // A place that can't be told (a room that is gone, or one the person may not see) is never shown as a blank name
  if (!place) return { state: 'none', place: null };
  if (!place.takesVisits) return { state: 'blocked', place: place.name, visiting: !!mine };
  return mine ? { state: 'visiting', place: place.name, startedAt: mine.startedAt.toISOString() } : { state: 'none', place: place.name };
}

/** The person's visit if it has not run out. */
async function liveVisit(userId: string, now: Date) {
  const visit = await prisma.brickVisit.findUnique({ where: { userId } });
  if (!visit) return null;
  return now.getTime() - visit.seenAt.getTime() > (await visitEndsAfterMs()) ? null : visit;
}

export type StartAnswer =
  | { ok: true; state: VisitState }
  | { ok: false; reason: 'not_found' | 'off' | 'no_place' | 'not_taken'; place?: string };

/**
 * The owner brings a Brick along, to the room they are in. Not found: it is not theirs, it waits deleted, or it is a room
 * bot. Off: its switch is off. Not taken: this place does not take visiting Bricks. It swaps whichever Brick was
 * walking with them, in one statement, so two taps never leave two.
 */
export async function startVisit(brickId: string, ownerId: string, roomUrl: string, now: Date = new Date()): Promise<StartAnswer> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true, enabled: true } });
  if (!brick || !ownsBrick(brick, ownerId)) return { ok: false, reason: 'not_found' };
  if (!brick.enabled) return { ok: false, reason: 'off' };
  const place = await placeOfRoomUrl(roomUrl);
  if (!place || !(await mayReadRoomBots(place.room, ownerId))) return { ok: false, reason: 'no_place' };
  if (!place.takesVisits) return { ok: false, reason: 'not_taken', place: place.name };
  // Two taps together can both clear the old row before either adds the new one; the one that loses the race to add it
  // tries once more, so it ends as the one visit the person has instead of failing
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.brickVisit.deleteMany({ where: { OR: [{ userId: ownerId }, { botId: brickId }] } });
        await tx.brickVisit.create({ data: { userId: ownerId, botId: brickId, roomId: place.roomId, startedAt: now, seenAt: now } });
      });
      break;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }
  return { ok: true, state: { state: 'visiting', place: place.name, startedAt: now.toISOString() } };
}

/** End the visit of this Brick. Only its owner's own row goes: nothing else of the Brick changes. Asked twice, the same. */
export async function endVisit(brickId: string, ownerId: string): Promise<boolean> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
  if (!brick || !ownsBrick(brick, ownerId)) return false;
  await prisma.brickVisit.deleteMany({ where: { userId: ownerId, botId: brickId } });
  return true;
}

/** Every visit nobody has seen for the time a super admin gave. The next read ignores them anyway. Returns how many went. */
export async function endStaleVisits(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - (await visitEndsAfterMs()));
  return (await prisma.brickVisit.deleteMany({ where: { seenAt: { lt: before } } })).count;
}

/** A Brick that stands, or walks, in a room: who it belongs to and how it got there. */
export interface BrickHere {
  botId: string;
  ownerId: string;
  kind: 'visiting';
  roomId: string;
  universeId: string;
}

/**
 * Where a Brick is right now, for the people who are not its owner: the room a live visit was last seen in, when that
 * room's universe takes visits. Null: it is nowhere other people can talk to it (at home with its owner's chats only).
 * `roomUrl`, when the caller knows the room the asker is in, must be that room: a Brick is never reached from a room
 * it is not in.
 */
export async function whereIsBrick(botId: string, roomUrl: string | null, now: Date = new Date()): Promise<(BrickHere & { place: Omit<Place, 'roomUrl'> }) | null> {
  const visit = await prisma.brickVisit.findUnique({ where: { botId }, include: { bot: { select: { enabled: true, deletedAt: true, roomId: true } } } });
  if (!visit || !visit.roomId || !visit.bot.enabled || visit.bot.deletedAt !== null || visit.bot.roomId !== null) return null;
  if (now.getTime() - visit.seenAt.getTime() > (await visitEndsAfterMs())) return null;
  const place = await placeOfRoomId(visit.roomId);
  if (!place || !place.takesVisits) return null;
  if (roomUrl) {
    const asked = await placeOfRoomUrl(roomUrl);
    if (!asked || asked.roomId !== visit.roomId) return null;
  }
  return { botId, ownerId: visit.userId, kind: 'visiting', roomId: visit.roomId, universeId: place.universeId, place };
}

/**
 * The visiting Bricks the bot server should have in this room, for the people it found there (their WorkAdventure
 * ids). Every person found has their visit seen here, now: that is where a Brick follows its person from room to room,
 * and what keeps a visit alive. A person who is not here, or whose Brick is off, deleted or not visiting, adds nothing;
 * and no Brick comes back where the universe does not take visiting Bricks, though the visit is still kept alive there.
 */
export async function bricksForRoom(roomUrl: string, peopleUuids: string[], now: Date = new Date()) {
  const place = await placeOfRoomUrl(roomUrl);
  if (!place) return { place: null, visiting: [] as VisitingBrickRow[] };
  if (peopleUuids.length === 0) return { place, visiting: [] as VisitingBrickRow[] };
  // A visit nobody has seen for too long has ended: it is not brought back by its person turning up again
  const stale = new Date(now.getTime() - (await visitEndsAfterMs()));
  const here = await prisma.brickVisit.findMany({
    where: { seenAt: { gte: stale }, user: { uuid: { in: peopleUuids.slice(0, 500) }, isGuest: false }, bot: { enabled: true, deletedAt: null, roomId: null } },
    select: {
      userId: true,
      user: { select: { uuid: true, name: true } },
      bot: { select: VISITING_BOT_SELECT },
    },
  });
  // A person is only seen in a room they may see: the bot server is told where people are by the game, and a visit never
  // moves to a room its person could not open
  const seen: typeof here = [];
  for (const row of here) {
    if (await mayReadRoomBots(place.room, row.userId)) seen.push(row);
  }
  if (seen.length === 0) return { place, visiting: [] as VisitingBrickRow[] };
  const userIds = seen.map((row) => row.userId);
  if (!place.takesVisits) {
    // Not on this map, but the person is still here: the visit is kept alive where it was, for the places that take it
    await prisma.brickVisit.updateMany({ where: { userId: { in: userIds } }, data: { seenAt: now } });
    return { place, visiting: [] as VisitingBrickRow[] };
  }
  await prisma.brickVisit.updateMany({ where: { userId: { in: userIds } }, data: { roomId: place.roomId, seenAt: now } });
  return { place, visiting: seen.map((row) => ({ ownerUuid: row.user.uuid, ownerName: row.user.name, bot: row.bot })) };
}

export const VISITING_BOT_SELECT = {
  id: true,
  name: true,
  ownerId: true,
  enabled: true,
  behaviorConfig: true,
  characterTextureId: true,
  createdAt: true,
  updatedAt: true,
  aiProviderRef: true,
  chatInstructions: true,
  toolTimeoutSeconds: true,
  maxReplyTokens: true,
  maxSteps: true,
  deletedAt: true,
} satisfies Prisma.BotSelect;

export interface VisitingBrickRow {
  ownerUuid: string;
  ownerName: string | null;
  bot: Prisma.BotGetPayload<{ select: typeof VISITING_BOT_SELECT }>;
}
