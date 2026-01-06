import { prisma } from '@/lib/db';
import { parsePlayUri, buildPlayUri } from '@/lib/utils';

/**
 * Resolve a playUri to a roomId
 * @param playUri - Full playUri URL (e.g., "http://play.workadventure.localhost/@/universe/world/room")
 * @returns The roomId UUID
 * @throws Error if playUri is invalid or room not found
 */
export async function resolveRoomIdFromPlayUri(playUri: string): Promise<string> {
  try {
    const { universe, world, room } = parsePlayUri(playUri);
    
    const roomRecord = await prisma.room.findFirst({
      where: {
        slug: room,
        world: {
          slug: world,
          universe: {
            slug: universe,
          },
        },
      },
      select: {
        id: true,
      },
    });
    
    if (!roomRecord) {
      throw new Error('Room not found');
    }
    
    return roomRecord.id;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Invalid playUri format');
  }
}

/**
 * Resolve a roomId to a playUri
 * @param roomId - The room UUID
 * @returns The full playUri URL
 * @throws Error if room not found
 */
export async function resolvePlayUriFromRoomId(roomId: string): Promise<string> {
  const playUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
  
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      world: {
        include: {
          universe: {
            select: {
              slug: true,
            },
          },
        },
      },
    },
  });
  
  if (!room) {
    throw new Error('Room not found');
  }
  
  return buildPlayUri(
    playUrl,
    room.world.universe.slug,
    room.world.slug,
    room.slug
  );
}

/**
 * Parse AI provider reference (stub implementation)
 * @param aiProviderRef - AI provider reference string
 * @returns Parsed AI provider object or undefined
 */
export function parseAiProvider(aiProviderRef: string | null): object | undefined {
  // Stub implementation - returns undefined for now
  // TODO: Implement actual parsing logic when AI provider format is defined
  return undefined;
}

/**
 * Get AI configuration (stub implementation)
 * @param aiProviderRef - AI provider reference string
 * @returns AI configuration object or undefined
 */
export async function getAiConfig(aiProviderRef: string | null): Promise<object | undefined> {
  // Stub implementation - returns undefined for now
  // TODO: Implement actual AI config retrieval when needed
  return undefined;
}

/**
 * Transform database bot to bot-server format
 * @param bot - Bot record from database with relations
 * @param includeSensitive - Whether to include sensitive fields
 * @param hasPermission - Whether user has permission to view sensitive data
 * @returns Transformed bot configuration for bot-server
 */
export async function transformBotToServerFormat(
  bot: any,
  includeSensitive: boolean,
  hasPermission: boolean
): Promise<any> {
  const playUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
  
  // Get behaviorConfig and ensure assignedSpace exists
  const behaviorConfig = bot.behaviorConfig as any;
  
  // Ensure assignedSpace exists in behaviorConfig
  if (!behaviorConfig.assignedSpace) {
    behaviorConfig.assignedSpace = {
      center: { x: 0, y: 0 },
      radius: 0,
    };
  }
  
  // Build URLs from room, world, and universe slugs
  const roomUrl = buildPlayUri(
    playUrl,
    bot.room.world.universe.slug,
    bot.room.world.slug,
    bot.room.slug
  );
  
  // World URL: /@/universe/world
  const worldUrl = `${playUrl}/@/${bot.room.world.universe.slug}/${bot.room.world.slug}`;
  
  // Universe URL: /@/universe
  const universeUrl = `${playUrl}/@/${bot.room.world.universe.slug}`;
  
  // Build base response with required fields
  const result: any = {
    botId: bot.id,
    name: bot.name,
    roomUrl,
    worldUrl,
    universeUrl,
    userId: bot.createdById,
    behaviorType: bot.behaviorType as 'idle' | 'patrol' | 'social',
    behaviorConfig: {
      ...behaviorConfig,
      behaviorType: bot.behaviorType,
      assignedSpace: behaviorConfig.assignedSpace,
    },
    assignedSpace: behaviorConfig.assignedSpace, // Top-level copy
    enabled: bot.enabled,
    characterTextureIds: bot.characterTextureId ? [bot.characterTextureId] : [],
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
  
  // Include sensitive fields only if requested and user has permission
  if (includeSensitive && hasPermission) {
    result.chatInstructions = bot.chatInstructions;
    result.movementInstructions = bot.movementInstructions;
    
    if (bot.aiProviderRef) {
      result.aiProvider = parseAiProvider(bot.aiProviderRef);
      result.aiConfig = await getAiConfig(bot.aiProviderRef);
    }
  }
  
  return result;
}

