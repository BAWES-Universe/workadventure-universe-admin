import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { parsePlayUri } from './utils';
import {
  PEOPLE_PREFERENCE_KEYS,
  SHARE_ROOM_KEY,
  SHARING_KEYS,
  shareRoomFromRows,
  sharePassportFromRows,
  peopleSettingsFromRows,
  type PeopleSettings,
} from './people-settings';

/**
 * Friends between Universe players.
 *
 * One `Friendship` row per pair, stored with user1Id < user2Id so a pair can only exist once.
 * `status` is one of:
 * - `pending`: `requestedById` asked the other person, who has not answered yet.
 * - `ignored`: the other person chose "Not now". The requester still sees it as pending, so nobody is told.
 * - `accepted`: friends.
 * - `blocked`: `requestedById` blocked the other person. Only the blocker can undo it.
 */
export type FriendshipStatus = 'pending' | 'ignored' | 'accepted' | 'blocked';

/** How a pair looks from one side. */
export type Relationship =
  | 'none'
  | 'friends'
  | 'request_sent'
  | 'request_received'
  | 'blocked_by_me'
  | 'blocked_by_them';

export type FriendAction = 'request' | 'accept' | 'ignore' | 'cancel' | 'remove' | 'block' | 'unblock';

export const FRIEND_ACTIONS: readonly FriendAction[] = ['request', 'accept', 'ignore', 'cancel', 'remove', 'block', 'unblock'];

/** Most requests one person can have waiting at once, so nobody can spray requests. */
export const MAX_OPEN_REQUESTS = 50;

/** A visit this recent to the same world counts as sharing it. */
export const SHARED_WORLD_VISIT_DAYS = 30;

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 64;
export const SEARCH_LIMIT = 20;

const OPEN_REQUEST: FriendshipStatus[] = ['pending', 'ignored'];

/** The pair's ids in storage order. */
export function orderedPair(a: string, b: string): { user1Id: string; user2Id: string } {
  return a < b ? { user1Id: a, user2Id: b } : { user1Id: b, user2Id: a };
}

export interface FriendshipRow {
  user1Id: string;
  user2Id: string;
  status: string;
  requestedById: string | null;
}

/** How `row` looks to `meId`. A missing row is `none`. */
export function relationshipFor(meId: string, row: FriendshipRow | null | undefined): Relationship {
  if (!row) return 'none';
  const mine = row.requestedById === meId;
  switch (row.status) {
    case 'accepted':
      return 'friends';
    case 'blocked':
      return mine ? 'blocked_by_me' : 'blocked_by_them';
    case 'pending':
    case 'ignored':
      return mine ? 'request_sent' : 'request_received';
    default:
      return 'none';
  }
}

function otherId(meId: string, row: FriendshipRow): string {
  return row.user1Id === meId ? row.user2Id : row.user1Id;
}

/** Thrown for a refused action; routes turn it into `{ error: code }` with `status`. */
export class FriendsError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export interface Account {
  id: string;
  uuid: string;
  name: string | null;
  matrixChatId: string | null;
}

/** A signed-in, non-guest user by WorkAdventure uuid, or null. */
export async function findAccount(uuid: string): Promise<Account | null> {
  const user = await prisma.user.findUnique({
    where: { uuid },
    select: { id: true, uuid: true, name: true, matrixChatId: true, isGuest: true },
  });
  if (!user || user.isGuest) return null;
  return { id: user.id, uuid: user.uuid, name: user.name, matrixChatId: user.matrixChatId };
}

/** The acting player. Friends are for signed-in players only. */
export async function requireAccount(uuid: string | null | undefined): Promise<Account> {
  if (!uuid) throw new FriendsError('userUuid is required', 400);
  const account = await findAccount(uuid);
  if (!account) throw new FriendsError('sign_in_required', 403);
  return account;
}

export async function loadPeopleSettings(userId: string): Promise<PeopleSettings> {
  return (await loadPeopleSettingsFor([userId])).get(userId)!;
}

/** Settings for several users in one query. Every id gets an entry, with defaults where nothing is stored. */
export async function loadPeopleSettingsFor(userIds: string[]): Promise<Map<string, PeopleSettings>> {
  const rows = userIds.length === 0 ? [] : await prisma.userPreference.findMany({
    where: { userId: { in: userIds }, key: { in: [...Object.values(PEOPLE_PREFERENCE_KEYS), ...SHARING_KEYS] } },
    select: { userId: true, key: true, value: true },
  });
  const result = new Map<string, PeopleSettings>();
  for (const id of userIds) result.set(id, peopleSettingsFromRows(rows.filter((row) => row.userId === id)));
  return result;
}

export async function savePeopleSettings(userId: string, changes: Partial<PeopleSettings>): Promise<PeopleSettings> {
  const { friendsSeeLocation, ...direct } = changes;
  // The game's "Friends see where I am" switch is one reading of Sharing's room choice: off is no one; on from off
  // is everyone, and from friends or everyone it leaves the choice as it was.
  if (friendsSeeLocation !== undefined) {
    const rows = await prisma.userPreference.findMany({ where: { userId, key: { in: [...SHARING_KEYS] } }, select: { key: true, value: true } });
    const current = shareRoomFromRows(rows);
    const next = friendsSeeLocation ? (current === 'nobody' ? 'everyone' : current) : 'nobody';
    if (next !== current || !rows.some((row) => row.key === SHARE_ROOM_KEY)) {
      await prisma.userPreference.upsert({
        where: { userId_key: { userId, key: SHARE_ROOM_KEY } },
        create: { userId, key: SHARE_ROOM_KEY, value: next },
        update: { value: next },
      });
    }
  }
  const writes = (Object.keys(direct) as (keyof typeof direct)[]).map((field) => {
    const key = PEOPLE_PREFERENCE_KEYS[field];
    const value = direct[field] as Prisma.InputJsonValue;
    return prisma.userPreference.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value },
      update: { value },
    });
  });
  if (writes.length > 0) await prisma.$transaction(writes);
  return loadPeopleSettings(userId);
}

/**
 * For each of `otherIds`, the name of a world it shares with `meId`: both members of it, or both visited it
 * in the last SHARED_WORLD_VISIT_DAYS days. Ids with nothing in common are missing from the map.
 */
export async function sharedWorldNames(meId: string, otherIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (otherIds.length === 0) return result;
  const ids = [meId, ...otherIds];

  const memberships = await prisma.worldMember.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, worldId: true, world: { select: { name: true } } },
  });
  matchWorlds(meId, memberships, result);
  if (result.size === otherIds.length) return result;

  const since = new Date(Date.now() - SHARED_WORLD_VISIT_DAYS * 24 * 60 * 60 * 1000);
  const visits = await prisma.roomAccess.findMany({
    where: { userId: { in: ids }, accessedAt: { gte: since } },
    select: { userId: true, worldId: true, world: { select: { name: true } } },
    distinct: ['userId', 'worldId'],
  });
  matchWorlds(meId, visits, result);
  return result;
}

/** Whether both accounts are members of one world. Unlike sharedWorldNames, recent visits do not count. */
export async function sharesMemberWorld(meId: string, otherId: string): Promise<boolean> {
  const rows = await prisma.worldMember.findMany({
    where: { userId: { in: [meId, otherId] } },
    select: { userId: true, worldId: true },
  });
  const mine = new Set(rows.filter((row) => row.userId === meId).map((row) => row.worldId));
  return rows.some((row) => row.userId === otherId && mine.has(row.worldId));
}

function matchWorlds(
  meId: string,
  rows: ReadonlyArray<{ userId: string | null; worldId: string; world: { name: string } }>,
  result: Map<string, string>,
) {
  const mine = new Map<string, string>();
  for (const row of rows) if (row.userId === meId) mine.set(row.worldId, row.world.name);
  for (const row of rows) {
    if (!row.userId || row.userId === meId || result.has(row.userId)) continue;
    const name = mine.get(row.worldId);
    if (name !== undefined) result.set(row.userId, name);
  }
}

async function findPair(aId: string, bId: string) {
  return prisma.friendship.findUnique({
    where: { user1Id_user2Id: orderedPair(aId, bId) },
    select: { id: true, user1Id: true, user2Id: true, status: true, requestedById: true },
  });
}

export interface FriendsList {
  friends: {
    uuid: string;
    name: string | null;
    chatId: string | null;
    shareLocation: boolean;
    since: string | null;
    /** When they last entered a room, or null when they hide where they are. */
    lastSeenAt: string | null;
  }[];
  incoming: { uuid: string; name: string | null; sharedWorld: string | null; requestedAt: string }[];
  outgoing: { uuid: string; name: string | null; sentAt: string }[];
  blocked: { uuid: string; name: string | null }[];
}

/** Everything the People panel needs about `me`'s friends, alphabetical by name. Hidden ("Not now") requests are left out. */
export async function listFriends(me: Account): Promise<FriendsList> {
  const rows = await prisma.friendship.findMany({
    where: { OR: [{ user1Id: me.id }, { user2Id: me.id }] },
    select: { user1Id: true, user2Id: true, status: true, requestedById: true, createdAt: true, acceptedAt: true },
  });
  const otherIds = rows.map((row) => otherId(me.id, row));
  const users = otherIds.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: otherIds }, isGuest: false },
    select: { id: true, uuid: true, name: true, matrixChatId: true },
  });
  const byId = new Map(users.map((user) => [user.id, user]));

  const friendRows = rows.filter((row) => row.status === 'accepted');
  const incomingRows = rows.filter((row) => row.status === 'pending' && row.requestedById !== me.id);
  const friendIds = friendRows.map((row) => otherId(me.id, row));
  const settings = await loadPeopleSettingsFor(friendIds);
  const lastSeen = await lastRoomEntries(friendIds.filter((id) => settings.get(id)?.friendsSeeLocation !== false));
  const shared = await sharedWorldNames(me.id, incomingRows.map((row) => otherId(me.id, row)));

  const list: FriendsList = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const row of rows) {
    const id = otherId(me.id, row);
    const user = byId.get(id);
    if (!user) continue;
    const relationship = relationshipFor(me.id, row);
    if (relationship === 'friends') {
      list.friends.push({
        uuid: user.uuid,
        name: user.name,
        chatId: user.matrixChatId,
        shareLocation: settings.get(id)?.friendsSeeLocation ?? true,
        since: row.acceptedAt?.toISOString() ?? null,
        lastSeenAt: lastSeen.get(id)?.toISOString() ?? null,
      });
    } else if (relationship === 'request_received' && row.status === 'pending') {
      list.incoming.push({ uuid: user.uuid, name: user.name, sharedWorld: shared.get(id) ?? null, requestedAt: row.createdAt.toISOString() });
    } else if (relationship === 'request_sent') {
      list.outgoing.push({ uuid: user.uuid, name: user.name, sentAt: row.createdAt.toISOString() });
    } else if (relationship === 'blocked_by_me') {
      list.blocked.push({ uuid: user.uuid, name: user.name });
    }
  }
  const byName = (a: { name: string | null }, b: { name: string | null }) =>
    (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' });
  list.friends.sort(byName);
  list.incoming.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  list.outgoing.sort(byName);
  list.blocked.sort(byName);
  return list;
}

/** Each user's latest room entry. */
async function lastRoomEntries(userIds: string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (userIds.length === 0) return result;
  const rows = await prisma.roomAccess.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
    _max: { accessedAt: true },
  });
  for (const row of rows) if (row.userId && row._max.accessedAt) result.set(row.userId, row._max.accessedAt);
  return result;
}

export const MAX_PLACES = 50;

export interface PlaceNames {
  universe: string;
  world: string;
  room: string;
}

/** Display names for room links, for showing where friends are. Unknown or malformed links map to null. */
export async function placeNames(playUris: string[]): Promise<Record<string, PlaceNames | null>> {
  const result: Record<string, PlaceNames | null> = {};
  const slugs = new Map<string, { universe: string; world: string; room: string }>();
  for (const playUri of new Set(playUris)) {
    result[playUri] = null;
    try {
      // The link's path is percent-encoded ("caf%C3%A9"); parsePlayUri gives the slugs as typed ("café").
      slugs.set(playUri, parsePlayUri(playUri));
    } catch {
      // Not a Universe room link (a /_/ or /~/ map), or a malformed one: no names to show.
    }
  }
  if (slugs.size === 0) return result;

  const rooms = await prisma.room.findMany({
    where: {
      OR: [...slugs.values()].map(({ universe, world, room }) => ({
        slug: room,
        world: { slug: world, universe: { slug: universe } },
      })),
    },
    select: { slug: true, name: true, world: { select: { slug: true, name: true, universe: { select: { slug: true, name: true } } } } },
  });
  for (const [playUri, wanted] of slugs) {
    const found = rooms.find((room) =>
      room.slug === wanted.room && room.world.slug === wanted.world && room.world.universe.slug === wanted.universe);
    if (found) result[playUri] = { universe: found.world.universe.name, world: found.world.name, room: found.name };
  }
  return result;
}

/** Applies `action` from `me` towards `target` and returns how the pair looks afterwards. */
export async function applyFriendAction(me: Account, target: Account, action: FriendAction): Promise<Relationship> {
  if (me.id === target.id) throw new FriendsError('cannot_friend_yourself', 400);
  try {
    return await runAction(me, target, action);
  } catch (error) {
    // Both sides sent a request at the same moment: the other row won, so act on it instead.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return runAction(me, target, action);
    }
    throw error;
  }
}

async function runAction(me: Account, target: Account, action: FriendAction): Promise<Relationship> {
  const pair = orderedPair(me.id, target.id);
  const row = await findPair(me.id, target.id);
  const current = relationshipFor(me.id, row);

  switch (action) {
    case 'request': {
      if (current === 'friends' || current === 'request_sent') return current;
      if (current === 'blocked_by_me' || current === 'blocked_by_them') throw new FriendsError('blocked', 403);
      if (current === 'request_received') return accept(me, target);

      const settings = await loadPeopleSettings(target.id);
      if (settings.friendRequestsFrom === 'nobody') throw new FriendsError('not_accepting_requests', 403);
      if (settings.friendRequestsFrom === 'shared_world' && !(await sharedWorldNames(me.id, [target.id])).has(target.id)) {
        throw new FriendsError('no_shared_world', 403);
      }
      const open = await prisma.friendship.count({ where: { requestedById: me.id, status: { in: OPEN_REQUEST } } });
      if (open >= MAX_OPEN_REQUESTS) throw new FriendsError('too_many_open_requests', 429);

      await prisma.friendship.create({ data: { ...pair, status: 'pending', requestedById: me.id } });
      return 'request_sent';
    }
    case 'accept':
      if (current === 'friends') return current;
      if (current !== 'request_received') throw new FriendsError('no_request', 409);
      return accept(me, target);
    case 'ignore': {
      const { count } = await prisma.friendship.updateMany({
        where: { ...pair, status: 'pending', requestedById: target.id },
        data: { status: 'ignored' },
      });
      if (count === 0 && current !== 'request_received') throw new FriendsError('no_request', 409);
      return 'request_received';
    }
    case 'cancel':
      if (current !== 'request_sent') return current;
      await prisma.friendship.deleteMany({ where: { ...pair, status: { in: OPEN_REQUEST }, requestedById: me.id } });
      return 'none';
    case 'remove':
      if (current !== 'friends') return current;
      await prisma.friendship.deleteMany({ where: { ...pair, status: 'accepted' } });
      return 'none';
    case 'block':
      if (current === 'blocked_by_me' || current === 'blocked_by_them') return current;
      if (row) {
        await prisma.friendship.update({
          where: { id: row.id },
          data: { status: 'blocked', requestedById: me.id, acceptedAt: null },
        });
      } else {
        await prisma.friendship.create({ data: { ...pair, status: 'blocked', requestedById: me.id } });
      }
      return 'blocked_by_me';
    case 'unblock':
      if (current !== 'blocked_by_me') return current;
      await prisma.friendship.deleteMany({ where: { ...pair, status: 'blocked', requestedById: me.id } });
      return 'none';
  }
}

async function accept(me: Account, target: Account): Promise<Relationship> {
  const { count } = await prisma.friendship.updateMany({
    where: { ...orderedPair(me.id, target.id), status: { in: OPEN_REQUEST }, requestedById: target.id },
    data: { status: 'accepted', acceptedAt: new Date() },
  });
  if (count === 0) {
    const now = relationshipFor(me.id, await findPair(me.id, target.id));
    if (now !== 'friends') throw new FriendsError('no_request', 409);
  }
  return 'friends';
}

export async function relationshipBetween(me: Account, target: Account): Promise<Relationship> {
  return relationshipFor(me.id, await findPair(me.id, target.id));
}

export interface SearchResult {
  uuid: string;
  name: string | null;
  universes: string[];
  relationship: Relationship;
}

/**
 * Players who haven't turned off being findable by name. Blocks in either direction hide the pair from each other.
 * Universes are where the player is a member, at most two, to tell people with the same name apart. They follow the
 * passport rule (see visibleStamps): only public worlds in public universes, and only to the people the player shows
 * their passport to (everyone, or friends and the searcher is one).
 */
export async function searchPeople(me: Account, rawQuery: string): Promise<SearchResult[]> {
  const query = rawQuery.trim();
  if (query.length < SEARCH_MIN_LENGTH || query.length > SEARCH_MAX_LENGTH) {
    throw new FriendsError('query_length', 400);
  }
  const users = await prisma.user.findMany({
    where: {
      isGuest: false,
      id: { not: me.id },
      name: { contains: query, mode: 'insensitive' },
      // Findable unless they switched it off: nothing is stored until someone changes the default.
      NOT: { preferences: { some: { key: PEOPLE_PREFERENCE_KEYS.findableByName, value: { equals: false } } } },
    },
    select: {
      id: true,
      uuid: true,
      name: true,
      worldMemberships: {
        where: { world: { isPublic: true, universe: { isPublic: true } } },
        select: { world: { select: { universe: { select: { name: true } } } } },
        take: 10,
      },
      preferences: { where: { key: { in: [...SHARING_KEYS] } }, select: { key: true, value: true } },
    },
    orderBy: { name: 'asc' },
    take: SEARCH_LIMIT * 2,
  });
  if (users.length === 0) return [];

  const rows = await prisma.friendship.findMany({
    where: {
      OR: users.map((user) => ({ user1Id: orderedPair(me.id, user.id).user1Id, user2Id: orderedPair(me.id, user.id).user2Id })),
    },
    select: { user1Id: true, user2Id: true, status: true, requestedById: true },
  });
  const rowFor = new Map(rows.map((row) => [otherId(me.id, row), row]));

  const results: SearchResult[] = [];
  for (const user of users) {
    const relationship = relationshipFor(me.id, rowFor.get(user.id));
    if (relationship === 'blocked_by_me' || relationship === 'blocked_by_them') continue;
    const audience = sharePassportFromRows(user.preferences);
    const mayShowPlaces = audience === 'everyone' || (audience === 'friends' && relationship === 'friends');
    const universes = mayShowPlaces
      ? [...new Set(user.worldMemberships.map((m) => m.world.universe.name))].slice(0, 2)
      : [];
    results.push({ uuid: user.uuid, name: user.name, universes, relationship });
    if (results.length === SEARCH_LIMIT) break;
  }
  return results;
}
