import { z } from 'zod';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth-session';
import { memberWorldIdsOf } from '@/lib/access-scope';
import { canSeeRoom } from '@/lib/room-visibility';
import { parsePlayUri } from '@/lib/utils';
import { HIDE_LOCATION_KEY, SHARING_KEYS, shareRoomFromRows } from '@/lib/people-settings';

/**
 * Live now: who is in Universe right now and where, read from the game server's live directory (the pusher's
 * `GET /presence`) and narrowed to what one person may see. Only rooms they could enter; a private world's people only
 * for its members; anyone who shares their room with no one is left out, from the counts too, and anyone who shares it
 * with friends only shows to their friends.
 */

export { HIDE_LOCATION_KEY };

export type LiveStatus = 'online' | 'busy' | 'away';

const snapshotSchema = z.object({
  generatedAt: z.number(),
  users: z.array(
    z.object({
      uuid: z.string(),
      status: z.enum(['online', 'busy', 'away']).catch('online'),
      woka: z.array(z.string()).catch([]),
      sessions: z.array(z.object({ playUri: z.string(), since: z.number() })),
    }),
  ),
  rooms: z.record(z.string(), z.object({ guests: z.number(), bots: z.number() })),
});
export type PresenceSnapshot = z.infer<typeof snapshotSchema>;

export interface LivePerson {
  uuid: string;
  name: string;
  status: LiveStatus;
  woka: string[];
  you: boolean;
  /** Whether they are the viewer's friend (accepted); what the Friends chip on Live now filters by. */
  friend: boolean;
}

export interface LivePlace {
  roomId: string;
  name: string;
  world: { id: string; name: string };
  universe: { id: string; name: string };
  /** Where the game goes: `/@/universe/world/room`. */
  playPath: string;
  /** Everyone counted: the people listed, guests and bots. */
  count: number;
  guests: number;
  bots: number;
  people: LivePerson[];
  here: boolean;
}

export interface LiveView {
  available: true;
  generatedAt: number;
  places: LivePlace[];
  /** Each person once, at the place they went to last; you are left out. */
  people: (LivePerson & { place: Pick<LivePlace, 'roomId' | 'name' | 'world' | 'universe' | 'playPath'> })[];
}

const CACHE_MS = 5_000;
const TIMEOUT_MS = 2_500;
const MAX_ROOMS = 500;

let cached: { at: number; snapshot: PresenceSnapshot | null } | null = null;
let inFlight: Promise<PresenceSnapshot | null> | null = null;

function playBase(): string | null {
  const base = process.env.PLAY_URL?.trim() || process.env.NEXT_PUBLIC_PLAY_URL?.trim();
  return base || null;
}

/** The game's live directory, shared by every viewer for a few seconds. Null when the game can't say. */
export async function fetchPresenceSnapshot(now = Date.now()): Promise<PresenceSnapshot | null> {
  if (cached && now - cached.at < CACHE_MS) return cached.snapshot;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const base = playBase();
    const token = process.env.ADMIN_API_TOKEN;
    let snapshot: PresenceSnapshot | null = null;
    if (base && token) {
      try {
        const response = await fetch(new URL('/presence', base), {
          headers: { Authorization: token },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        });
        if (response.ok) {
          const parsed = snapshotSchema.safeParse(await response.json());
          if (parsed.success) snapshot = parsed.data;
          else console.warn('[Live] The game sent a presence list Orbit could not read');
        } else if (response.status !== 404) {
          console.warn(`[Live] The game answered ${response.status} for presence`);
        }
      } catch (error) {
        console.warn('[Live] Could not reach the game for presence:', error instanceof Error ? error.message : error);
      }
    }
    cached = { at: Date.now(), snapshot };
    return snapshot;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** For tests: forget the shared copy. */
export function resetPresenceCache(): void {
  cached = null;
  inFlight = null;
}

/** A room's address as one map key. JSON keeps the three slugs apart even when a slug holds a "/". */
function slugKey(universe: string, world: string, room: string): string {
  return JSON.stringify([universe, world, room]);
}

function keyOf(playUri: string): string | null {
  try {
    // parsePlayUri already decodes each slug; decoding again would break a slug holding a "%".
    const { universe, world, room } = parsePlayUri(playUri);
    return slugKey(universe, world, room);
  } catch {
    return null;
  }
}

/** Woka layers as the game gave them, made absolute against the game's address; anything but http(s) is dropped. */
function wokaLayers(layers: string[], base: string | null): string[] {
  const out: string[] = [];
  for (const layer of layers.slice(0, 8)) {
    try {
      const url = base ? new URL(layer, base) : new URL(layer);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.toString());
    } catch {
      // Not a URL: skip the layer.
    }
  }
  return out;
}

/** What this viewer may see of the snapshot. */
export async function buildLiveView(snapshot: PresenceSnapshot, viewer: SessionUser): Promise<LiveView> {
  const base = playBase();

  // Where everyone is, by room.
  const usersByKey = new Map<string, { uuid: string; since: number }[]>();
  for (const user of snapshot.users) {
    for (const session of user.sessions) {
      const key = keyOf(session.playUri);
      if (!key) continue;
      const list = usersByKey.get(key) ?? [];
      if (!list.some((entry) => entry.uuid === user.uuid)) list.push({ uuid: user.uuid, since: session.since });
      usersByKey.set(key, list);
    }
  }
  const visitorsByKey = new Map<string, { guests: number; bots: number }>();
  for (const [playUri, counts] of Object.entries(snapshot.rooms)) {
    const key = keyOf(playUri);
    if (!key) continue;
    const sum = visitorsByKey.get(key) ?? { guests: 0, bots: 0 };
    visitorsByKey.set(key, { guests: sum.guests + counts.guests, bots: sum.bots + counts.bots });
  }

  const keys = [...new Set([...usersByKey.keys(), ...visitorsByKey.keys()])].slice(0, MAX_ROOMS);
  if (keys.length === 0) return { available: true, generatedAt: snapshot.generatedAt, places: [], people: [] };

  const rooms = await prisma.room.findMany({
    where: {
      OR: keys.map((key) => {
        const [universe, world, room] = JSON.parse(key) as [string, string, string];
        return { slug: room, world: { slug: world, universe: { slug: universe } } };
      }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      isPublic: true,
      world: {
        select: {
          id: true,
          name: true,
          slug: true,
          isPublic: true,
          universe: { select: { id: true, name: true, slug: true, isPublic: true, ownerId: true } },
        },
      },
    },
  });
  const memberWorldIds = await memberWorldIdsOf(viewer.id, [...new Set(rooms.map((room) => room.world.id))]);
  const visibleRooms = rooms.filter((room) => canSeeRoom(room, viewer, memberWorldIds));

  // The people in those rooms, by name, minus anyone who doesn't share their room with you (you always see yourself).
  const uuids = new Set<string>();
  for (const room of visibleRooms) {
    for (const entry of usersByKey.get(slugKey(room.world.universe.slug, room.world.slug, room.slug)) ?? []) {
      uuids.add(entry.uuid);
    }
  }
  const people = uuids.size
    ? await prisma.user.findMany({
        where: { uuid: { in: [...uuids] }, isGuest: false },
        select: { id: true, uuid: true, name: true, preferences: { where: { key: { in: [...SHARING_KEYS] } }, select: { key: true, value: true } } },
      })
    : [];
  // Which of them are the viewer's friends: decides who shares with friends only, and what the Friends chip shows.
  const others = people.filter((person) => person.uuid !== viewer.uuid).map((person) => person.id);
  const friendIds = new Set(
    others.length === 0 || !viewer.id
      ? []
      : (
          await prisma.friendship.findMany({
            where: {
              status: 'accepted',
              OR: [
                { user1Id: viewer.id, user2Id: { in: others } },
                { user2Id: viewer.id, user1Id: { in: others } },
              ],
            },
            select: { user1Id: true, user2Id: true },
          })
        ).map((row) => (row.user1Id === viewer.id ? row.user2Id : row.user1Id)),
  );
  const snapshotByUuid = new Map(snapshot.users.map((user) => [user.uuid, user]));
  const shown = new Map<string, LivePerson>();
  for (const person of people) {
    const share = shareRoomFromRows(person.preferences);
    const you = person.uuid === viewer.uuid;
    if (!you && (share === 'nobody' || (share === 'friends' && !friendIds.has(person.id)))) continue;
    const live = snapshotByUuid.get(person.uuid);
    if (!live) continue;
    shown.set(person.uuid, {
      uuid: person.uuid,
      name: person.name?.trim() || 'Someone',
      status: live.status,
      woka: wokaLayers(live.woka, base),
      you,
      friend: !you && friendIds.has(person.id),
    });
  }

  const places: LivePlace[] = [];
  const latest = new Map<string, { since: number; place: LivePlace }>();
  for (const room of visibleRooms) {
    const key = slugKey(room.world.universe.slug, room.world.slug, room.slug);
    const entries = (usersByKey.get(key) ?? []).filter((entry) => shown.has(entry.uuid));
    const visitors = visitorsByKey.get(key) ?? { guests: 0, bots: 0 };
    const count = entries.length + visitors.guests + visitors.bots;
    if (count === 0) continue;
    const place: LivePlace = {
      roomId: room.id,
      name: room.name,
      world: { id: room.world.id, name: room.world.name },
      universe: { id: room.world.universe.id, name: room.world.universe.name },
      // Each slug encoded, so the game reads back the same three, whatever characters they hold.
      playPath: `/@/${[room.world.universe.slug, room.world.slug, room.slug].map(encodeURIComponent).join('/')}`,
      count,
      guests: visitors.guests,
      bots: visitors.bots,
      // Most recent arrivals first, so the faces change as people come in.
      people: [...entries].sort((a, b) => b.since - a.since).map((entry) => shown.get(entry.uuid)!),
      here: entries.some((entry) => entry.uuid === viewer.uuid),
    };
    places.push(place);
    for (const entry of entries) {
      const seen = latest.get(entry.uuid);
      if (!seen || entry.since > seen.since) latest.set(entry.uuid, { since: entry.since, place });
    }
  }
  places.sort((a, b) => Number(b.here) - Number(a.here) || b.count - a.count || a.name.localeCompare(b.name));

  const peopleOnline: LiveView['people'] = [];
  for (const [uuid, { place }] of latest) {
    const person = shown.get(uuid)!;
    if (person.you) continue;
    const { roomId, name, world, universe, playPath } = place;
    peopleOnline.push({ ...person, place: { roomId, name, world, universe, playPath } });
  }
  peopleOnline.sort((a, b) => a.name.localeCompare(b.name));

  return { available: true, generatedAt: snapshot.generatedAt, places, people: peopleOnline };
}
