import type { SessionUser } from '@/lib/auth-session';

/** Who is looking: only their id and whether they are a super admin matter. */
type Viewer = Pick<SessionUser, 'id' | 'isSuperAdmin'> | null;

export interface VisibleRoomRecord {
  isPublic: boolean;
  world: {
    id: string;
    isPublic: boolean;
    universe: { isPublic: boolean; ownerId: string };
  };
}

/**
 * Whether this person may see a room: it and its world and universe are public, or they own the universe, or they
 * are a member of the world. Super admins see everything.
 */
export function canSeeRoom(room: VisibleRoomRecord, viewer: Viewer, memberWorldIds: Set<string>): boolean {
  if (viewer?.isSuperAdmin) return true;
  if (viewer && room.world.universe.ownerId === viewer.id) return true;
  if (memberWorldIds.has(room.world.id)) return true;
  return room.isPublic && room.world.isPublic && room.world.universe.isPublic;
}

export interface VisibleWorldRecord {
  id: string;
  isPublic: boolean;
  universe: { isPublic: boolean; ownerId: string };
}

/**
 * Whether this person may see a world: it and its universe are public, or they own the universe, or they are a member
 * of the world. Super admins see everything. The same rule as a room, one level up.
 */
export function canSeeWorld(world: VisibleWorldRecord, viewer: Viewer, memberWorldIds: Set<string>): boolean {
  if (viewer?.isSuperAdmin) return true;
  if (viewer && world.universe.ownerId === viewer.id) return true;
  if (memberWorldIds.has(world.id)) return true;
  return world.isPublic && world.universe.isPublic;
}

/**
 * Whether this person may see a universe: it is public, or they own it, or they are a member of one of its worlds.
 * Super admins see everything.
 */
export function canSeeUniverse(
  universe: { isPublic: boolean; ownerId: string },
  viewer: Viewer,
  memberOfAWorldInIt: boolean,
): boolean {
  if (viewer?.isSuperAdmin) return true;
  if (viewer && universe.ownerId === viewer.id) return true;
  if (memberOfAWorldInIt) return true;
  return universe.isPublic;
}
