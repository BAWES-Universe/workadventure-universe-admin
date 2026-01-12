import { prisma } from '@/lib/db';

/**
 * Checks if a user can manage bots in a specific room
 * Returns true if:
 * 1. User is the Universe owner (room.world.universe.ownerId === userId), OR
 * 2. User is a WorldMember with 'admin' or 'editor' tag
 */
export async function canManageBots(userId: string, roomId: string): Promise<boolean> {
  // First, get the room with its world and universe relations
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      world: {
        include: {
          universe: {
            select: {
              ownerId: true,
            },
          },
        },
      },
    },
  });

  if (!room) {
    return false;
  }

  // Check if user is the universe owner
  const isUniverseOwner = room.world.universe.ownerId === userId;
  if (isUniverseOwner) {
    return true;
  }

  // Check if user is a WorldMember with admin or editor tags
  const hasEditPermission = await prisma.worldMember.findFirst({
    where: {
      worldId: room.worldId,
      userId: userId,
      tags: {
        hasSome: ['admin', 'editor'],
      },
    },
  });

  return !!hasEditPermission;
}

