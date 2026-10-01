import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The System account: seeded by prisma/seed.ts to own the built-in default universe. It is nobody, so it never shows
 * as a person. What it owns (its universes, and their worlds and rooms) is hidden from lists, searches and counts once
 * START_ROOM_URL points somewhere else; while the start room is still System's, nothing of it is hidden here.
 * Pages and the game still open any of it by direct link.
 */
export const SYSTEM_USER_EMAIL = 'system@workadventure.local';

/** People lists and counts leave the System account out, for everyone. */
export const NOT_SYSTEM_USER: Prisma.UserWhereInput = { OR: [{ email: null }, { email: { not: SYSTEM_USER_EMAIL } }] };
/** The same, as SQL over `users u`. */
export const NOT_SYSTEM_USER_SQL = Prisma.sql`(u.email IS NULL OR u.email <> ${SYSTEM_USER_EMAIL})`;

const DEFAULT_START_ROOM = '@/default/default/default';

/**
 * START_ROOM_URL as `@/universe/world/room` (also from a full play URL such as `https://host/@/u/w/r`), or null when
 * it is not a room path (a map file URL, say).
 */
export function startRoomPath(): string | null {
  let value = (process.env.START_ROOM_URL || DEFAULT_START_ROOM).trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  const parts = value.split('/').filter(Boolean);
  return parts.length >= 4 && parts[0] === '@' ? parts.slice(0, 4).join('/') : null;
}

const CACHE_MS = 60_000;
let cached: { at: number; systemId: string | null; startInSystem: boolean } | null = null;

/** Forget the cached answer (tests). */
export function resetSystemSpacesCache(): void {
  cached = null;
}

/** System's id, and whether the start room's universe is System's. Cached briefly: START_ROOM_URL rarely moves. */
async function lookup(): Promise<{ systemId: string | null; startInSystem: boolean }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const system = await prisma.user.findUnique({ where: { email: SYSTEM_USER_EMAIL }, select: { id: true } });
  const path = startRoomPath();
  let startInSystem = false;
  if (system && path) {
    const universe = await prisma.universe.findUnique({ where: { slug: path.split('/')[1] }, select: { ownerId: true } });
    startInSystem = universe?.ownerId === system.id;
  }
  cached = { at: Date.now(), systemId: system?.id ?? null, startInSystem };
  return cached;
}

/** System's user id, or null when there is no System account. */
export async function getSystemUserId(): Promise<string | null> {
  return (await lookup()).systemId;
}

/** Whether START_ROOM_URL lands in a universe System owns (a fresh install). */
export async function isStartRoomInSystemSpaces(): Promise<boolean> {
  return (await lookup()).startInSystem;
}

/**
 * System's id when its spaces are to be hidden (the start room is elsewhere), otherwise null: nothing to hide.
 * A failed lookup hides nothing, so lists keep working as they did before.
 */
export async function hiddenSystemOwnerId(): Promise<string | null> {
  try {
    const { systemId, startInSystem } = await lookup();
    return systemId && !startInSystem ? systemId : null;
  } catch (error) {
    console.warn('[system-user] Could not tell whether to hide System spaces', error);
    return null;
  }
}

/** Whether System's spaces are hidden from lists right now. */
export async function shouldHideSystemSpaces(): Promise<boolean> {
  return (await hiddenSystemOwnerId()) !== null;
}

/** Prisma filters leaving out what `ownerId` (System) owns; empty when nothing is hidden. */
export function notSystemUniverse(ownerId: string | null): Prisma.UniverseWhereInput {
  return ownerId ? { ownerId: { not: ownerId } } : {};
}
export function notSystemWorld(ownerId: string | null): Prisma.WorldWhereInput {
  return ownerId ? { universe: notSystemUniverse(ownerId) } : {};
}
export function notSystemRoom(ownerId: string | null): Prisma.RoomWhereInput {
  return ownerId ? { world: notSystemWorld(ownerId) } : {};
}

/** `AND <alias>.owner_id <> System` for a query over `universes <alias>`; nothing when nothing is hidden. */
export function andNotSystemOwnedSql(ownerId: string | null, alias = 'u'): Prisma.Sql {
  return ownerId ? Prisma.sql`AND ${Prisma.raw(alias)}.owner_id <> ${ownerId}` : Prisma.empty;
}
