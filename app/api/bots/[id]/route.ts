import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { z } from 'zod';

// Validation schema for updating a bot (all fields optional for partial updates)
const updateBotSchema = z.object({
  roomId: z.string().uuid('roomId must be a valid UUID').optional(),
  name: z.string().min(1, 'name cannot be empty').max(100, 'name must be at most 100 characters').optional(),
  description: z.string().optional().nullable(),
  characterTextureId: z.string().max(100, 'characterTextureId must be at most 100 characters').optional().nullable(),
  enabled: z.boolean().optional(),
  behaviorType: z.enum(['idle', 'patrol', 'social'], {
    message: 'behaviorType must be one of: idle, patrol, social',
  }).optional(),
  behaviorConfig: z.record(z.string(), z.any()).optional(),
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

// GET /api/bots/:id
// Get a single bot by UUID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

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

    // Fetch bot with room relation (including world and universe for visibility check)
    const bot = await prisma.bot.findUnique({
      where: { id },
      include: {
        room: {
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
        },
      },
    });

    if (!bot) {
      return NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
    }

    // Check visibility: public if room.isPublic AND world.isPublic AND universe.isPublic
    const isPublic = bot.room.isPublic && bot.room.world.isPublic && bot.room.world.universe.isPublic;

    // If not public, require authentication
    if (!isPublic && !isAuthenticated) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Transform to camelCase
    const transformedBot = transformBot(bot);

    return NextResponse.json(transformedBot);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    console.error('Error fetching bot:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PUT /api/bots/:id
// Update a bot
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

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

    // Check if bot exists
    const existingBot = await prisma.bot.findUnique({
      where: { id },
      include: {
        room: true,
      },
    });

    if (!existingBot) {
      return NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, existingBot.roomId);
      if (!hasPermission) {
        return NextResponse.json(
          { error: 'You do not have permission to manage bots in this room' },
          { status: 403 }
        );
      }
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = updateBotSchema.parse(body);

    // If roomId is being updated, verify the new room exists
    if (validatedData.roomId && validatedData.roomId !== existingBot.roomId) {
      const newRoom = await prisma.room.findUnique({
        where: { id: validatedData.roomId },
      });

      if (!newRoom) {
        return NextResponse.json(
          { error: 'Room not found' },
          { status: 404 }
        );
      }

      // Check permissions for the new room
      if (!isAdminToken && userId) {
        const hasPermission = await canManageBots(userId, validatedData.roomId);
        if (!hasPermission) {
          return NextResponse.json(
            { error: 'You do not have permission to manage bots in the target room' },
            { status: 403 }
          );
        }
      }
    }

    // Prepare update data (only include fields that were provided)
    const updateData: any = {};
    if (validatedData.roomId !== undefined) updateData.roomId = validatedData.roomId;
    if (validatedData.name !== undefined) updateData.name = validatedData.name;
    if (validatedData.description !== undefined) updateData.description = validatedData.description;
    if (validatedData.characterTextureId !== undefined) updateData.characterTextureId = validatedData.characterTextureId;
    if (validatedData.enabled !== undefined) updateData.enabled = validatedData.enabled;
    if (validatedData.behaviorType !== undefined) updateData.behaviorType = validatedData.behaviorType;
    if (validatedData.behaviorConfig !== undefined) updateData.behaviorConfig = validatedData.behaviorConfig;
    if (validatedData.chatInstructions !== undefined) updateData.chatInstructions = validatedData.chatInstructions;
    if (validatedData.movementInstructions !== undefined) updateData.movementInstructions = validatedData.movementInstructions;
    if (validatedData.aiProviderRef !== undefined) updateData.aiProviderRef = validatedData.aiProviderRef;

    // Update bot (updatedAt is automatically updated by Prisma)
    const bot = await prisma.bot.update({
      where: { id },
      data: updateData,
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

      return NextResponse.json(transformedBot);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid input data',
          details: error.issues,
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
    console.error('Error updating bot:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/bots/:id
// Delete a bot by UUID
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

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

    // Check if bot exists
    const bot = await prisma.bot.findUnique({
      where: { id },
      include: {
        room: true,
      },
    });

    if (!bot) {
      return NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, bot.roomId);
      if (!hasPermission) {
        return NextResponse.json(
          { error: 'You do not have permission to manage bots in this room' },
          { status: 403 }
        );
      }
    }

    // Delete bot
    await prisma.bot.delete({
      where: { id },
    });

    // Return 204 No Content on success
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    console.error('Error deleting bot:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

