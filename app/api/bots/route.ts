import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { z } from 'zod';

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
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');

    if (!roomId) {
      return NextResponse.json(
        { error: 'roomId query parameter is required' },
        { status: 400 }
      );
    }

    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') &&
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;

    let userId: string | null = null;
    let isAuthenticated = false;

    if (!isAdminToken) {
      // Try to get user from session
      const sessionUser = await getSessionUser(request);
      if (sessionUser) {
        userId = sessionUser.id;
        isAuthenticated = true;
      }
    } else {
      // Admin token - require it
      requireAuth(request);
      isAuthenticated = true;
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
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }

    // Check visibility: public if room.isPublic AND world.isPublic AND universe.isPublic
    const isPublic = room.isPublic && room.world.isPublic && room.world.universe.isPublic;

    // If not public, require authentication
    if (!isPublic && !isAuthenticated) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
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
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Transform bots to camelCase
    const transformedBots = bots.map(transformBot);

    return NextResponse.json(transformedBots);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    console.error('Error fetching bots:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/bots
// Create a new bot
export async function POST(request: NextRequest) {
  try {
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') &&
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;

    let userId: string | null = null;

    if (!isAdminToken) {
      // Try to get user from session
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }
      userId = sessionUser.id;
    } else {
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
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, validatedData.roomId);
      if (!hasPermission) {
        return NextResponse.json(
          { error: 'You do not have permission to manage bots in this room' },
          { status: 403 }
        );
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
      },
    });

    // Transform to camelCase
    const transformedBot = transformBot(bot);

    return NextResponse.json(transformedBot, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid input data',
          details: error.errors,
        },
        { status: 400 }
      );
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    console.error('Error creating bot:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

