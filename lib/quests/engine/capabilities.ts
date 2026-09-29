import type { QuestScopeType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { canManageRoom, canManageUniverse, canManageWorld, isPrivileged, viewerUserId, type Viewer } from '@/lib/access-scope';

/**
 * What a person may do with quests in a scope. Publication, applicability, management and progress visibility are
 * separate questions; these are the management ones. A person's own progress is theirs (lib/quests/engine/progress.ts)
 * and needs none of these.
 */
export type QuestCapability =
  | 'manage-quests'
  | 'view-aggregate-progress'
  | 'view-individual-progress'
  | 'grant-badges'
  | 'register-integrations';

export interface CapabilityScope {
  scopeType: QuestScopeType;
  /** "" or null for the platform. */
  scopeId: string | null;
}

/** Managers (owner, or a world admin or editor) manage and see aggregates; only the universe's owner sees people or grants. */
const OWNER_ONLY: ReadonlySet<QuestCapability> = new Set(['view-individual-progress', 'grant-badges', 'register-integrations']);

async function universeOwnerOf(scope: CapabilityScope): Promise<string | null> {
  switch (scope.scopeType) {
    case 'UNIVERSE': {
      const universe = scope.scopeId ? await prisma.universe.findUnique({ where: { id: scope.scopeId }, select: { ownerId: true } }) : null;
      return universe?.ownerId ?? null;
    }
    case 'WORLD': {
      const world = scope.scopeId ? await prisma.world.findUnique({ where: { id: scope.scopeId }, select: { universe: { select: { ownerId: true } } } }) : null;
      return world?.universe.ownerId ?? null;
    }
    case 'ROOM': {
      const room = scope.scopeId
        ? await prisma.room.findUnique({ where: { id: scope.scopeId }, select: { world: { select: { universe: { select: { ownerId: true } } } } } })
        : null;
      return room?.world.universe.ownerId ?? null;
    }
    case 'PLATFORM':
      return null;
  }
}

export async function hasQuestCapability(viewer: Viewer | null, capability: QuestCapability, scope: CapabilityScope): Promise<boolean> {
  if (isPrivileged(viewer)) return true;
  const userId = viewerUserId(viewer);
  if (!userId || scope.scopeType === 'PLATFORM' || !scope.scopeId) return false;
  if (OWNER_ONLY.has(capability)) return (await universeOwnerOf(scope)) === userId;
  switch (scope.scopeType) {
    case 'UNIVERSE':
      return canManageUniverse(userId, scope.scopeId);
    case 'WORLD':
      return canManageWorld(userId, scope.scopeId);
    case 'ROOM':
      return canManageRoom(userId, scope.scopeId);
  }
}
