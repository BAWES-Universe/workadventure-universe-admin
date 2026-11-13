import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { mayReadRoomBots, whoMayReadRoomBots } from '@/lib/bot-room-access';
import { canManageBots } from '@/lib/bot-permissions';
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
  // A Brick that is switched off or waits deleted is not walking with anyone (as in `whereIsBrick`): its page says nothing of a visit
  const mine = visit?.botId === brickId && (await isWalkable(brickId)) ? visit : null;
  let place: Pick<Place, 'name' | 'takesVisits'> | null = null;
  if (roomUrl) {
    const found = await placeOfRoomUrl(roomUrl);
    // A room the person may not see is not described to them: they only learn it is not somewhere Bricks visit
    if (found && (await mayReadRoomBots(found.room, ownerId))) place = found;
  } else if (mine?.roomId) {
    const found = await placeOfRoomId(mine.roomId);
    if (found && (await mayReadRoomBots(found.room, ownerId))) place = found;
  }
  // A place that can't be told (a room that is gone, or one the person may not see) is never shown as a blank name
  if (!place) return { state: 'none', place: null };
  if (!place.takesVisits) return { state: 'blocked', place: place.name, visiting: !!mine };
  return mine ? { state: 'visiting', place: place.name, startedAt: mine.startedAt.toISOString() } : { state: 'none', place: place.name };
}

/** Whether a Brick is on (switched on and not deleted): only then can it walk with its person. */
async function isWalkable(brickId: string): Promise<boolean> {
  const brick = await prisma.bot.findUnique({ where: { id: brickId }, select: { enabled: true, deletedAt: true } });
  return !!brick && brick.enabled && brick.deletedAt === null;
}

/** The person's visit if it has not run out. */
async function liveVisit(userId: string, now: Date) {
  const visit = await prisma.brickVisit.findUnique({ where: { userId } });
  if (!visit) return null;
  return now.getTime() - visit.seenAt.getTime() > (await visitEndsAfterMs()) ? null : visit;
}

export type StartAnswer =
  | { ok: true; state: VisitState }
  | { ok: false; reason: 'not_found' | 'off' | 'no_place' | 'not_taken' | 'lives_in'; place?: string };

/**
 * The owner brings a Brick along, to the room they are in. Not found: it is not theirs, it waits deleted, or it is a room
 * bot. Off: its switch is off. Not taken: this place does not take visiting Bricks. Lives in: it has a home in a room
 * (`place` is that room's name), so it cannot also walk beside its owner: one place at a time; taking it out of its room
 * frees it. It swaps whichever Brick was walking with them, in one statement, so two taps never leave two.
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
      const livesIn = await prisma.$transaction(async (tx) => {
        // The Brick's row is held while this decides, as placing it in a room does, so a home and a visit are never both
        // written for it by two requests at once; a Brick deleted a moment ago is not visited
        const held = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "bots" WHERE "id" = ${brickId} AND "deleted_at" IS NULL AND "room_id" IS NULL FOR UPDATE`);
        if (held.length === 0) return { gone: true as const };
        const home = await tx.brickHome.findUnique({ where: { botId: brickId }, select: { roomId: true, placedById: true, room: { select: { name: true } } } });
        // A home whose placer can no longer manage bots there has already ended (it goes on every read and in the sweep): it does not keep the Brick from a visit
        if (home && (await canManageBots(home.placedById, home.roomId))) return { room: home.room.name };
        if (home) await tx.brickHome.deleteMany({ where: { botId: brickId } });
        await tx.brickVisit.deleteMany({ where: { OR: [{ userId: ownerId }, { botId: brickId }] } });
        await tx.brickVisit.create({ data: { userId: ownerId, botId: brickId, roomId: place.roomId, startedAt: now, seenAt: now } });
        return null;
      });
      if (livesIn && 'gone' in livesIn) return { ok: false, reason: 'not_found' };
      if (livesIn) return { ok: false, reason: 'lives_in', place: livesIn.room };
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

/**
 * The bot server's own client for the visiting Brick sees its owner in this room: the visit is seen now. Only this and the
 * owner's own sync (`bricksForRoom`) keep a visit alive; people chatting with the Brick never do. Answers whether the visit is
 * still alive: false when there is none for this owner and Brick, it is expired (an expired visit is never brought back
 * by a sighting), the Brick is off or deleted, the place no longer takes visits, or its owner may no longer open the room,
 * and the bot server then takes the Brick off the map.
 */
export async function keepVisitAlive(botId: string, ownerUuid: string, roomUrl: string, now: Date = new Date()): Promise<boolean> {
  const visit = await prisma.brickVisit.findUnique({
    where: { botId },
    include: { user: { select: { uuid: true, isGuest: true } }, bot: { select: { enabled: true, deletedAt: true, roomId: true } } },
  });
  if (!visit || visit.user.uuid !== ownerUuid || visit.user.isGuest) return false;
  if (!visit.bot.enabled || visit.bot.deletedAt !== null || visit.bot.roomId !== null) return false;
  const stale = new Date(now.getTime() - (await visitEndsAfterMs()));
  if (visit.seenAt < stale) return false;
  const place = await placeOfRoomUrl(roomUrl);
  if (!place || !place.takesVisits || !(await mayReadRoomBots(place.room, visit.userId))) return false;
  // A sighting only counts in the room the visit is in: an owner who has already walked on to another room is not seen by the
  // Brick they left, and a late sighting from there must not pull the visit back (nor end it: the Brick is alive, elsewhere)
  // The row is only touched while it is still live and still in this room, so a visit that ran out or moved between the read
  // and now is left as it is
  const seen = await prisma.brickVisit.updateMany({ where: { botId, userId: visit.userId, roomId: place.roomId, seenAt: { gte: stale } }, data: { seenAt: now } });
  if (seen.count > 0) return true;
  const current = await prisma.brickVisit.findUnique({ where: { botId }, select: { userId: true, roomId: true, seenAt: true } });
  return !!current && current.userId === visit.userId && current.roomId !== place.roomId && current.seenAt >= stale;
}

/** A Brick that stands, or walks, in a room: who it belongs to and how it got there. */
export interface BrickHere {
  botId: string;
  ownerId: string;
  /** `home`: its owner gave it a place in the room (game #2005, "Add one of your Bricks"). `visiting`: it walks beside its owner. */
  kind: 'visiting' | 'home';
  roomId: string;
  universeId: string;
}

/**
 * Where a Brick is right now, for the people who are not its owner: the room it has as a home, and the room a live visit
 * was last seen in (when that room's universe takes visits). Null: it is nowhere other people can talk to it (it is at
 * home with its owner's chats only). `roomUrl`, when the caller knows the room the asker is in, must be one of those: a
 * Brick is never reached from a room it is not in. Without it, the room it has as a home comes first, then its visit.
 *
 * A home holds only while the person who placed it can still manage bots in that room; one that no longer does is not
 * a place (and is removed by the next sweep). A Brick that is off or waits deleted is nowhere. A home does not depend on
 * the Visiting Bricks switch: that switch is about visits.
 */
export async function whereIsBrick(botId: string, roomUrl: string | null, now: Date = new Date()): Promise<(BrickHere & { place: Omit<Place, 'roomUrl'> }) | null> {
  const [home, visit] = await Promise.all([
    prisma.brickHome.findUnique({ where: { botId }, include: { bot: { select: { enabled: true, deletedAt: true, roomId: true, ownerId: true } } } }),
    prisma.brickVisit.findUnique({ where: { botId }, include: { bot: { select: { enabled: true, deletedAt: true, roomId: true } } } }),
  ]);
  const candidates: { kind: BrickHere['kind']; roomId: string; ownerId: string }[] = [];
  if (home && home.bot.enabled && home.bot.deletedAt === null && home.bot.roomId === null && home.bot.ownerId === home.placedById && (await canManageBots(home.placedById, home.roomId))) {
    candidates.push({ kind: 'home', roomId: home.roomId, ownerId: home.placedById });
  }
  if (visit && visit.roomId && visit.bot.enabled && visit.bot.deletedAt === null && visit.bot.roomId === null && now.getTime() - visit.seenAt.getTime() <= (await visitEndsAfterMs())) {
    const place = await placeOfRoomId(visit.roomId);
    // Its owner's access is checked now, not only when the visit began: where they may no longer open the room, the Brick is
    // nowhere other people can reach it
    if (place?.takesVisits && (await mayReadRoomBots(place.room, visit.userId))) candidates.push({ kind: 'visiting', roomId: visit.roomId, ownerId: visit.userId });
  }
  if (candidates.length === 0) return null;
  let chosen = candidates[0];
  if (roomUrl) {
    const asked = await placeOfRoomUrl(roomUrl);
    const match = asked ? candidates.find((one) => one.roomId === asked.roomId) : undefined;
    if (!match) return null;
    chosen = match;
  }
  const place = await placeOfRoomId(chosen.roomId);
  if (!place) return null;
  return { botId, ownerId: chosen.ownerId, kind: chosen.kind, roomId: chosen.roomId, universeId: place.universeId, place };
}

/**
 * The visiting Bricks the bot server should have in this room, for the people it found there (their WorkAdventure
 * ids). Every person found has their visit seen here, now: that is where a Brick follows its person from room to room,
 * and what keeps a visit alive. A person who is not here, or whose Brick is off, deleted or not visiting, adds nothing;
 * and no Brick comes back where the universe does not take visiting Bricks, though the visit is still kept alive there.
 *
 * `enteredAt` is when the person's game saw them come into this room (never later than now; missing means now). A visit
 * only moves to this room when that is newer than when it last moved (`roomSince`): a sync that arrives late, from a room
 * the person has already left, moves nothing, refreshes nothing and brings nothing back, and is named in `late`. The two
 * times are only compared when the same page load of the game (`clientId`) said both: a second device has a clock of its
 * own, so a sighting from another one (or from a game that names none) is a move, as it always was.
 */
export async function bricksForRoom(roomUrl: string, peopleUuids: string[], now: Date = new Date(), enteredAt?: Date, clientId?: string) {
  const place = await placeOfRoomUrl(roomUrl);
  const none = { visiting: [] as VisitingBrickRow[], late: [] as string[] };
  if (!place) return { place: null, ...none };
  if (peopleUuids.length === 0) return { place, ...none };
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
  const mayRead = await whoMayReadRoomBots(place.room, here.map((row) => row.userId));
  const seen = here.filter((row) => mayRead.has(row.userId));
  if (seen.length === 0) return { place, ...none };
  const userIds = seen.map((row) => row.userId);
  const sightedAt = enteredAt && enteredAt.getTime() < now.getTime() ? enteredAt : now;
  // Somewhere else: it moves here unless this sighting is older than the move that put it there, by the same page load's clock
  const newer = clientId ? [{ roomSince: null }, { roomClient: null }, { roomClient: { not: clientId } }, { roomSince: { lt: sightedAt } }] : undefined;
  if (!place.takesVisits) {
    // Not on this map, but the person is still here: the visit is kept alive for the places that take it, and it is not left
    // standing in the room they came from, where people could still reach a Brick whose person is elsewhere now
    await prisma.brickVisit.updateMany({
      where: { userId: { in: userIds }, ...(newer ? { AND: [{ OR: newer }] } : {}) },
      data: { roomId: null, roomSince: sightedAt, roomClient: clientId ?? null, seenAt: now },
    });
    return { place, ...none };
  }
  // Already in this room: seen now. Somewhere else: moved here only when this sighting is newer than the move that put it there
  // (equal or older is a late sync from a room the person has left, and changes nothing)
  await prisma.brickVisit.updateMany({ where: { userId: { in: userIds }, roomId: place.roomId }, data: { seenAt: now } });
  // A visit that began in this room has no time yet: this sighting is the first
  await prisma.brickVisit.updateMany({ where: { userId: { in: userIds }, roomId: place.roomId, roomSince: null }, data: { roomSince: sightedAt, roomClient: clientId ?? null } });
  await prisma.brickVisit.updateMany({
    where: { userId: { in: userIds }, OR: [{ roomId: null }, { roomId: { not: place.roomId } }], ...(newer ? { AND: [{ OR: newer }] } : {}) },
    data: { roomId: place.roomId, roomSince: sightedAt, roomClient: clientId ?? null, seenAt: now },
  });
  // Only the ones that stand in this room now come back: a late sync brings no Brick to a room its person has left
  const inThisRoom = new Set((await prisma.brickVisit.findMany({ where: { userId: { in: userIds }, roomId: place.roomId }, select: { userId: true } })).map((row) => row.userId));
  const standing = seen.filter((row) => inThisRoom.has(row.userId));
  const late = seen.filter((row) => !inThisRoom.has(row.userId)).map((row) => row.user.uuid);
  return { place, visiting: standing.map((row) => ({ ownerUuid: row.user.uuid, ownerName: row.user.name, bot: row.bot })), late };
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
