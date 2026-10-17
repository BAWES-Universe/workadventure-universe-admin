/**
 * The "Used in" tab of a role (#314): where a role opens doors and what it reaches, worked out only from what Orbit
 * can really read.
 *
 * - Rooms: Orbit has no per-room list of roles. A room is open to everyone (it, its world and its universe are
 *   public) or to the members of its world (canSeeRoom). So "rooms set to this role" is real for Member (the
 *   members-only rooms) and Everyone (the open rooms), and for every other role there is none to list.
 * - Map areas: a map area is locked to roles in its map file (a WAM in map-storage), as read and write tags that are
 *   role keys. Orbit does not keep a copy, but map-storage serves the file, so it is read from there, a few at a
 *   time. The file's address is rebuilt from the slugs and the current map-storage address, as the rest of Orbit does
 *   (the stored one can be stale). A room whose file cannot be read is counted, never guessed.
 */
import { prisma } from '@/lib/db';
import { getWamUrl } from '@/lib/map-storage';
import { canSeeRoom, canSeeWorld } from '@/lib/room-visibility';
import { keysOf, type PermissionKey } from '@/lib/permissions';
import { EVERYONE_KEY, MEMBER_KEY, worldsOf, type WorldScope } from '@/lib/roles';

/** At most this many room maps are read per request, so a big universe never holds the page up. */
export const MAX_MAPS_READ = 60;
const READ_AT_ONCE = 6;
const READ_TIMEOUT_MS = 4000;
/** How many names each list carries; the rest are counted. */
export const LIST_LIMIT = 30;

export interface UsedInRoom {
  id: string;
  name: string;
  worldId: string;
  worldName: string;
}

export interface LockedArea {
  roomId: string;
  roomName: string;
  worldName: string;
  areaName: string;
  /** Read tags decide who may enter an area; write tags decide who may edit it. */
  level: 'enter' | 'edit';
}

export type MapAreasStatus =
  /** Every map that has a file was read. */
  | 'read'
  /** Some were not read: see `unread` (could not be read) and `skipped` (past the cap). */
  | 'partial'
  /** Orbit has no map-storage address here, so no map can be read. */
  | 'not_configured';

export interface UsedIn {
  doors: {
    basis: 'members' | 'everyone' | 'none';
    rooms: UsedInRoom[];
    roomsTotal: number;
  };
  reach: {
    /** Whether anyone holds the role at all. Only a yes or no: the worlds a viewer cannot see are never named or counted. */
    held: boolean;
    /** The role's badge is off and the viewer neither gives nor manages roles: who holds it is not said, so nothing here is derived from it. */
    hidden: boolean;
    allWorlds: boolean;
    worlds: { id: string; name: string }[];
    rooms: UsedInRoom[];
    roomsTotal: number;
    mapAreas: {
      status: MapAreasStatus;
      areas: LockedArea[];
      /** Rooms whose map file could not be read: the download failed or it is not on map-storage. */
      unread: number;
      /** Rooms with a map file that were not tried, because only the first MAX_MAPS_READ are read at once. */
      skipped: number;
      /** Rooms whose map file was read. */
      read: number;
    };
    permissions: PermissionKey[];
  };
}

/** The areas of a map file whose read or write tags name a role. Anything that is not a map file gives none. */
export function areasLockedTo(wam: unknown, roleKey: string): { areaName: string; level: 'enter' | 'edit' }[] {
  const areas = (wam as { areas?: unknown } | null)?.areas;
  if (!Array.isArray(areas)) return [];
  const found: { areaName: string; level: 'enter' | 'edit' }[] = [];
  for (const area of areas) {
    const properties = (area as { properties?: unknown } | null)?.properties;
    if (!Array.isArray(properties)) continue;
    const name = typeof (area as { name?: unknown }).name === 'string' && (area as { name: string }).name ? (area as { name: string }).name : 'Unnamed area';
    for (const property of properties) {
      const data = property as { type?: unknown; disabled?: unknown; readTags?: unknown; writeTags?: unknown } | null;
      // A property switched off is ignored by the game, so it is ignored here
      if (!data || data.type !== 'restrictedRightsPropertyData' || data.disabled === true) continue;
      const names = (tags: unknown) => Array.isArray(tags) && tags.includes(roleKey);
      if (names(data.readTags)) found.push({ areaName: name, level: 'enter' });
      if (names(data.writeTags)) found.push({ areaName: name, level: 'edit' });
    }
  }
  return found;
}

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The domain a map is filed under in map-storage: the same rule as the room and map routes. */
function playDomain(): string {
  if (process.env.DEFAULT_DOMAIN) return process.env.DEFAULT_DOMAIN;
  try {
    return new URL(process.env.PLAY_URL ?? '').hostname;
  } catch {
    return 'workadventure.localhost';
  }
}

async function readWam(url: string, fetcher: Fetcher): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface RoomRecord {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  wamUrl: string | null;
  world: { id: string; name: string; slug: string; isPublic: boolean; universe: { isPublic: boolean; ownerId: string; slug: string } };
}

export interface UsedInInput {
  universeId: string;
  role: { id: string; key: string; permissions: bigint; showBadge?: boolean };
  /** Who is looking: only the rooms they can see are named. */
  viewer: { id: string; isSuperAdmin: boolean };
  /** They give or manage roles, so they see who holds a role whose badge is off (the server's rule, `seesHiddenRoles`). */
  seesHidden?: boolean;
  fetcher?: Fetcher;
}

function roomRef(room: RoomRecord): UsedInRoom {
  return { id: room.id, name: room.name, worldId: room.world.id, worldName: room.world.name };
}

export async function computeUsedIn(input: UsedInInput): Promise<UsedIn> {
  const { universeId, role, viewer } = input;
  const fetcher = input.fetcher ?? (fetch as unknown as Fetcher);

  const [worlds, rooms, viewerWorlds] = await Promise.all([
    prisma.world.findMany({
      where: { universeId },
      select: { id: true, name: true, isPublic: true, universe: { select: { isPublic: true, ownerId: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.room.findMany({
      where: { world: { universeId } },
      select: {
        id: true,
        name: true,
        slug: true,
        isPublic: true,
        wamUrl: true,
        world: { select: { id: true, name: true, slug: true, isPublic: true, universe: { select: { isPublic: true, ownerId: true, slug: true } } } },
      },
      orderBy: [{ world: { createdAt: 'asc' } }, { createdAt: 'asc' }],
    }),
    prisma.worldMember.findMany({ where: { userId: viewer.id, world: { universeId } }, select: { worldId: true } }),
  ]);
  const memberWorldIds = new Set(viewerWorlds.map((row) => row.worldId));
  const visible = (rooms as RoomRecord[]).filter((room) => canSeeRoom(room, viewer, memberWorldIds));
  const universeWorldIds = worlds.map((world) => world.id);
  const openToEveryone = (room: RoomRecord) => room.isPublic && room.world.isPublic && room.world.universe.isPublic;

  // Where the role works: Everyone reaches every world; anyone else, the worlds its holders have it in
  // A hidden role does not say who holds it, so what follows from that (worlds, rooms) is left out, not read
  const hidden = role.key !== EVERYONE_KEY && role.key !== MEMBER_KEY && role.showBadge === false && !input.seesHidden;
  let scopes: WorldScope[];
  if (hidden) {
    scopes = [];
  } else if (role.key === EVERYONE_KEY) {
    scopes = [{ allWorlds: true, worldIds: [] }];
  } else if (role.key === MEMBER_KEY) {
    scopes = await prisma.universeMember.findMany({ where: { universeId }, select: { allWorlds: true, worldIds: true } });
  } else {
    scopes = await prisma.universeMemberRole.findMany({ where: { roleId: role.id }, select: { allWorlds: true, worldIds: true } });
  }
  const reached = new Set<string>();
  for (const scope of scopes) for (const id of worldsOf(scope, universeWorldIds)) reached.add(id);
  // A private world the viewer can't see is not named: not its id, not its name
  const held = scopes.length > 0;
  const reachedWorlds = worlds
    .filter((world) => reached.has(world.id) && canSeeWorld(world, viewer, memberWorldIds))
    .map((world) => ({ id: world.id, name: world.name }));
  const allWorlds = universeWorldIds.length > 0 && universeWorldIds.every((id) => reached.has(id));

  // Rooms the role reaches: Everyone, the open ones; anyone else, every room in the worlds it works in
  const reachRooms = visible.filter((room) => reached.has(room.world.id) && (role.key !== EVERYONE_KEY || openToEveryone(room)));

  let doorRooms: RoomRecord[] = [];
  let basis: UsedIn['doors']['basis'] = 'none';
  if (role.key === MEMBER_KEY) {
    basis = 'members';
    doorRooms = visible.filter((room) => !openToEveryone(room));
  } else if (role.key === EVERYONE_KEY) {
    basis = 'everyone';
    doorRooms = visible.filter(openToEveryone);
  }

  // Map areas locked to the role: read the map files, a few at a time
  const storage = process.env.PUBLIC_MAP_STORAGE_URL;
  const areas: LockedArea[] = [];
  let status: MapAreasStatus = 'read';
  let unread = 0;
  let skipped = 0;
  let read = 0;
  if (!storage) {
    status = 'not_configured';
  } else {
    const domain = playDomain();
    // A room with a map file has a stored address; the address that is read is rebuilt from where the room is now
    const withMap = visible.filter((room) => room.wamUrl);
    const batch = withMap.slice(0, MAX_MAPS_READ);
    skipped = withMap.length - batch.length;
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const room = batch[next++];
        const url = getWamUrl(domain, room.world.universe.slug, room.world.slug, room.slug, storage);
        const wam = await readWam(url, fetcher);
        if (wam === undefined) {
          unread += 1;
          continue;
        }
        read += 1;
        for (const found of areasLockedTo(wam, role.key)) {
          areas.push({ roomId: room.id, roomName: room.name, worldName: room.world.name, ...found });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, batch.length) }, worker));
    if (unread > 0 || skipped > 0) status = 'partial';
  }

  return {
    doors: { basis, rooms: doorRooms.slice(0, LIST_LIMIT).map(roomRef), roomsTotal: doorRooms.length },
    reach: {
      held,
      hidden,
      allWorlds,
      worlds: reachedWorlds,
      rooms: reachRooms.slice(0, LIST_LIMIT).map(roomRef),
      roomsTotal: reachRooms.length,
      mapAreas: { status, areas, unread, skipped, read },
      // Administrator expands to every permission
      permissions: keysOf(role.permissions),
    },
  };
}
