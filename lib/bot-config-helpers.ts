import type { Bot } from '@prisma/client';
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

  // This shape is a room bot's: it is built around the room's URL. A Brick (game #1992) has none, and the callers answer
  // for a Brick before they get here.
  if (!bot.room) throw new Error('A bot with no room has no configuration in the room bot shape');
  
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
      showToolCalls: behaviorConfig.showToolCalls === true,
      behaviorType: bot.behaviorType,
      assignedSpace: behaviorConfig.assignedSpace,
    },
    assignedSpace: behaviorConfig.assignedSpace, // Top-level copy
    enabled: bot.enabled,
    characterTextureIds: bot.characterTextureId ? [bot.characterTextureId] : [],
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
    // Always include these configuration fields - bot server needs them
    aiProviderRef: bot.aiProviderRef || null,
    chatInstructions: bot.chatInstructions || null,
    movementInstructions: bot.movementInstructions || null,
    toolTimeoutSeconds: bot.toolTimeoutSeconds ?? null,
    maxReplyTokens: bot.maxReplyTokens ?? null,
    maxSteps: bot.maxSteps ?? null,
    companionTextureId: bot.companionTextureId ?? null,
    // The owner's voice switch: the bot server joins the bubble's audio (and the game shows the Voice button) only when it is true
    voiceEnabled: bot.voiceEnabled === true,
  };
  
  // Include parsed AI provider data only if requested and user has permission
  if (includeSensitive && hasPermission && bot.aiProviderRef) {
    result.aiProvider = parseAiProvider(bot.aiProviderRef);
    result.aiConfig = await getAiConfig(bot.aiProviderRef);
  }
  
  return result;
}

/**
 * A Brick for the bot server (game #1995): the same fields a room bot has, with no room, world or universe URL, and
 * `brick` saying whose it is. A Brick lives in its owner's chats, so it stands nowhere: it never moves and is never put
 * on a map from this answer. Its voice stays off here: a Brick is spoken to in a call, which is its own issue.
 *
 * A Brick its owner deleted (game #1996) is still answered while it waits for Undo, as off and with `brick.deleted`
 * true, and never as "not found": a bot server takes "not found" as gone for good and closes the bot's chats, and Undo
 * has to find the chat as it was. It is "not found" from the day it is removed.
 */
export function transformBrickToServerFormat(
  bot: Pick<
    Bot,
    | 'id'
    | 'name'
    | 'ownerId'
    | 'enabled'
    | 'behaviorConfig'
    | 'characterTextureId'
    | 'createdAt'
    | 'updatedAt'
    | 'aiProviderRef'
    | 'chatInstructions'
    | 'toolTimeoutSeconds'
    | 'maxReplyTokens'
    | 'maxSteps'
    | 'deletedAt'
  >,
  isDefault: boolean
) {
  const config = bot.behaviorConfig;
  const stored: Record<string, unknown> = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const assignedSpace = { center: { x: 0, y: 0 }, radius: 0 };
  return {
    botId: bot.id,
    name: bot.name,
    brick: { ownerId: bot.ownerId, isDefault, deleted: bot.deletedAt !== null },
    roomUrl: null,
    worldUrl: null,
    universeUrl: null,
    userId: bot.ownerId,
    behaviorType: 'idle',
    behaviorConfig: { ...stored, showToolCalls: stored.showToolCalls === true, behaviorType: 'idle', assignedSpace },
    assignedSpace,
    // The database keeps a deleted Brick off; said here too, so the answer never depends on that alone
    enabled: bot.enabled && bot.deletedAt === null,
    characterTextureIds: bot.characterTextureId ? [bot.characterTextureId] : [],
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
    aiProviderRef: bot.aiProviderRef || null,
    chatInstructions: bot.chatInstructions || null,
    movementInstructions: null,
    toolTimeoutSeconds: bot.toolTimeoutSeconds ?? null,
    maxReplyTokens: bot.maxReplyTokens ?? null,
    maxSteps: bot.maxSteps ?? null,
    companionTextureId: null,
    voiceEnabled: false,
  };
}

/**
 * A Brick that visits a room with its owner (game #2005): the same fields the Brick has everywhere, with the room it is
 * in, and `brick.visiting` saying whose it walks beside, so the bot server can put it next to that person. It stays with
 * them: no space of its own, no roaming and no greeting. Its voice stays off, as for every Brick.
 */
export function transformVisitingBrickToServerFormat(
  bot: Parameters<typeof transformBrickToServerFormat>[0],
  isDefault: boolean,
  where: { roomUrl: string },
  owner: { uuid: string; name: string | null }
) {
  const base = transformBrickToServerFormat(bot, isDefault);
  const url = new URL(where.roomUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const universeUrl = `${url.origin}/${parts.slice(0, 2).join('/')}`;
  const worldUrl = `${url.origin}/${parts.slice(0, 3).join('/')}`;
  return {
    ...base,
    brick: { ...base.brick, visiting: { ownerUuid: owner.uuid, ownerName: owner.name } },
    roomUrl: where.roomUrl,
    worldUrl,
    universeUrl,
  };
}

/**
 * A save that replaces a bot's whole behavior config must not silently turn "Show tool calls"
 * back off just because the caller did not know about that key. An explicit true or false
 * from the caller still wins.
 */
export function keepToolCallSetting(
  stored: unknown,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  if ('showToolCalls' in incoming) return incoming;
  const storedValue =
    stored && typeof stored === 'object' ? (stored as Record<string, unknown>).showToolCalls : undefined;
  return typeof storedValue === 'boolean' ? { ...incoming, showToolCalls: storedValue } : incoming;
}

/**
 * The same for where a bot's images go (the Vision row): a save that replaces the whole behavior config without a `vision`
 * key must not drop what the owner picked. An explicit value, or null (back to nothing picked), from the caller wins.
 */
export function keepVisionPick(
  stored: unknown,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  if ('vision' in incoming) return incoming;
  const storedValue =
    stored && typeof stored === 'object' ? (stored as Record<string, unknown>).vision : undefined;
  return storedValue && typeof storedValue === 'object' ? { ...incoming, vision: storedValue } : incoming;
}
