import type { SessionUser } from '@/lib/auth-session';

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
export function canSeeRoom(room: VisibleRoomRecord, viewer: SessionUser | null, memberWorldIds: Set<string>): boolean {
  if (viewer?.isSuperAdmin) return true;
  if (viewer && room.world.universe.ownerId === viewer.id) return true;
  if (memberWorldIds.has(room.world.id)) return true;
  return room.isPublic && room.world.isPublic && room.world.universe.isPublic;
}
