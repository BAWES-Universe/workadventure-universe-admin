import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { parsePlayUri } from '@/lib/utils';
import { validateAccessToken } from '@/lib/oidc';
import { z } from 'zod';

// Ensure this route runs in Node.js runtime (not Edge) to support Prisma
export const runtime = 'nodejs';

// CORS headers helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * OPTIONS /api/bots
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

// Validation schema for creating a bot
const createBotSchema = z.object({
  roomId: z.string().uuid('roomId must be a valid UUID'),
  name: z.string().min(1, 'name is required').max(100, 'name must be at most 100 characters'),
  description: z.string().optional().nullable(),
  characterTextureId: z.string().max(100, 'characterTextureId must be at most 100 characters').optional().nullable(),
  enabled: z.boolean().optional().default(true),
  behaviorType: z.enum(['idle', 'patrol', 'social'], {
    message: 'behaviorType must be one of: idle, patrol, social',
  }),
  behaviorConfig: z.record(z.string(), z.any()).default({}),
  chatInstructions: z.string().optional().nullable(),
  movementInstructions: z.string().optional().nullable(),
  aiProviderRef: z.string().max(100, 'aiProviderRef must be at most 100 characters').optional().nullable(),
});

// Helper function to transform bot data from database to API response (snake_case to camelCase)
function transformBot(bot: any) {
  return {
    id: bot.id,
    roomId: bot.roomId,
    name: bot.name,
    description: bot.description,
    characterTextureId: bot.characterTextureId,
    enabled: bot.enabled,
    behaviorType: bot.behaviorType,
    behaviorConfig: bot.behaviorConfig,
    chatInstructions: bot.chatInstructions,
    movementInstructions: bot.movementInstructions,
    aiProviderRef: bot.aiProviderRef,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    ...(bot.createdBy && {
      createdBy: {
        id: bot.createdBy.id,
        name: bot.createdBy.name,
        email: bot.createdBy.email,
      },
    }),
    ...(bot.updatedBy && {
      updatedBy: {
        id: bot.updatedBy.id,
        name: bot.updatedBy.name,
        email: bot.updatedBy.email,
      },
    }),
    ...(bot.room && {
      room: {
        id: bot.room.id,
        worldId: bot.room.worldId,
        slug: bot.room.slug,
        name: bot.room.name,
        description: bot.room.description,
        mapUrl: bot.room.mapUrl,
        wamUrl: bot.room.wamUrl,
        isPublic: bot.room.isPublic,
        createdAt: bot.room.createdAt,
        updatedAt: bot.room.updatedAt,
      },
    }),
  };
}

// GET /api/bots?roomId={roomId}
// List all bots for a specific room
// roomId can be either a UUID or a playUri (e.g., http://play.workadventure.localhost/@/universe/world/room)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomIdOrPlayUri = searchParams.get('roomId');

    if (!roomIdOrPlayUri) {
      const response = NextResponse.json(
        { error: 'roomId query parameter is required' },
        { status: 400 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Get user ID from various auth methods
    const { userId, isAdminToken } = await getUserIdFromRequest(request);
    const isAuthenticated = isAdminToken || !!userId;

    if (isAdminToken) {
      // Admin token - require it
      requireAuth(request);
    }

    // Determine if roomIdOrPlayUri is a UUID or a playUri
    let roomId: string;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomIdOrPlayUri);
    
    if (isUuid) {
      // It's a UUID, use it directly
      roomId = roomIdOrPlayUri;
    } else {
      // It's a playUri, parse it and find the room by slugs
      try {
        const { universe, world, room } = parsePlayUri(roomIdOrPlayUri);
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
          const response = NextResponse.json(
            { error: 'Room not found' },
            { status: 404 }
          );
          Object.entries(corsHeaders()).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }
        
        roomId = roomRecord.id;
      } catch (parseError) {
        const response = NextResponse.json(
          { error: 'Invalid playUri format. Expected UUID or playUri like http://play.workadventure.localhost/@/universe/world/room' },
          { status: 400 }
        );
        Object.entries(corsHeaders()).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Get room with world and universe to check visibility
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        world: {
          include: {
            universe: {
              select: {
                id: true,
                isPublic: true,
              },
            },
          },
        },
      },
    });

    if (!room) {
      const response = NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Check visibility: public if room.isPublic AND world.isPublic AND universe.isPublic
    const isPublic = room.isPublic && room.world.isPublic && room.world.universe.isPublic;

    // If not public, require authentication
    if (!isPublic && !isAuthenticated) {
      const response = NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Fetch bots for this room
    const bots = await prisma.bot.findMany({
      where: { roomId },
      include: {
        room: {
          select: {
            id: true,
            worldId: true,
            slug: true,
            name: true,
            description: true,
            mapUrl: true,
            wamUrl: true,
            isPublic: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Transform bots to camelCase
    const transformedBots = bots.map(transformBot);

    const response = NextResponse.json(transformedBots);
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      const response = NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }
    console.error('Error fetching bots:', error);
    const response = NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  }
}

// Helper function to get user ID from various auth methods
async function getUserIdFromRequest(request: NextRequest): Promise<{ userId: string | null; isAdminToken: boolean }> {
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No Bearer token, try session
    const sessionUser = await getSessionUser(request);
    return { userId: sessionUser?.id || null, isAdminToken: false };
  }
  
  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.ADMIN_API_TOKEN;
  
  // Check if it's the admin API token
  if (expectedToken && token === expectedToken) {
    return { userId: null, isAdminToken: true };
  }
  
  // Try to validate as OIDC token
  try {
    const userInfo = await validateAccessToken(token);
    if (userInfo) {
      // Find or create user from OIDC token
      const identifier = userInfo.sub || userInfo.email || 'unknown';
      let user = await prisma.user.findFirst({
        where: {
          OR: [
            { uuid: identifier },
            { email: userInfo.email || undefined },
          ],
        },
      });
      
      if (!user) {
        // Create user if doesn't exist
        user = await prisma.user.create({
          data: {
            uuid: identifier,
            email: userInfo.email || null,
            name: userInfo.name || userInfo.preferred_username || null,
            isGuest: false,
          },
        });
      }
      
      return { userId: user.id, isAdminToken: false };
    }
  } catch (error) {
    // Token validation failed, continue to try session
  }
  
  // Fall back to session
  const sessionUser = await getSessionUser(request);
  return { userId: sessionUser?.id || null, isAdminToken: false };
}

// POST /api/bots
// Create a new bot
export async function POST(request: NextRequest) {
  try {
    // Get user ID from various auth methods
    const { userId, isAdminToken } = await getUserIdFromRequest(request);

    if (!isAdminToken && !userId) {
      const response = NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    if (isAdminToken) {
      // Admin token - require it
      requireAuth(request);
      // For admin token, we'll skip permission check (full access)
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = createBotSchema.parse(body);

    // Verify room exists
    const room = await prisma.room.findUnique({
      where: { id: validatedData.roomId },
    });

    if (!room) {
      const response = NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, validatedData.roomId);
      if (!hasPermission) {
        const response = NextResponse.json(
          { error: 'You do not have permission to manage bots in this room' },
          { status: 403 }
        );
        Object.entries(corsHeaders()).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Create bot
    const bot = await prisma.bot.create({
      data: {
        roomId: validatedData.roomId,
        name: validatedData.name,
        description: validatedData.description ?? null,
        characterTextureId: validatedData.characterTextureId ?? null,
        enabled: validatedData.enabled ?? true,
        behaviorType: validatedData.behaviorType,
        behaviorConfig: validatedData.behaviorConfig ?? {},
        chatInstructions: validatedData.chatInstructions ?? null,
        movementInstructions: validatedData.movementInstructions ?? null,
        aiProviderRef: validatedData.aiProviderRef ?? null,
        createdById: userId ?? null,
        updatedById: userId ?? null,
      },
      include: {
        room: {
          select: {
            id: true,
            worldId: true,
            slug: true,
            name: true,
            description: true,
            mapUrl: true,
            wamUrl: true,
            isPublic: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Transform to camelCase
    const transformedBot = transformBot(bot);

    const response = NextResponse.json(transformedBot, { status: 201 });
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const response = NextResponse.json(
        {
          error: 'Invalid input data',
          details: error.issues,
        },
        { status: 400 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      const response = NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }
    console.error('Error creating bot:', error);
    const response = NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  }
}

