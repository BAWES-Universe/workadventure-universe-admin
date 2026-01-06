import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
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
 * OPTIONS /api/bots/:id
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
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

// GET /api/bots/:id
// Get a single bot by UUID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Get user ID from various auth methods
    const { userId, isAdminToken } = await getUserIdFromRequest(request);
    const isAuthenticated = isAdminToken || !!userId;

    if (isAdminToken) {
      // Admin token - require it
      requireAuth(request);
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

    if (!bot) {
      const response = NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Check visibility: public if room.isPublic AND world.isPublic AND universe.isPublic
    const isPublic = bot.room.isPublic && bot.room.world.isPublic && bot.room.world.universe.isPublic;

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

    // Transform to camelCase
    const transformedBot = transformBot(bot);

    const response = NextResponse.json(transformedBot);
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
    console.error('Error fetching bot:', error);
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

// PUT /api/bots/:id
// Update a bot
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

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

    // Check if bot exists
    const existingBot = await prisma.bot.findUnique({
      where: { id },
      include: {
        room: true,
      },
    });

    if (!existingBot) {
      const response = NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, existingBot.roomId);
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

    // Parse and validate request body
    const body = await request.json();
    const validatedData = updateBotSchema.parse(body);

    // If roomId is being updated, verify the new room exists
    if (validatedData.roomId && validatedData.roomId !== existingBot.roomId) {
      const newRoom = await prisma.room.findUnique({
        where: { id: validatedData.roomId },
      });

      if (!newRoom) {
        const response = NextResponse.json(
          { error: 'Room not found' },
          { status: 404 }
        );
        Object.entries(corsHeaders()).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // Check permissions for the new room
      if (!isAdminToken && userId) {
        const hasPermission = await canManageBots(userId, validatedData.roomId);
        if (!hasPermission) {
          const response = NextResponse.json(
            { error: 'You do not have permission to manage bots in the target room' },
            { status: 403 }
          );
          Object.entries(corsHeaders()).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
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
    // Always update updatedById when any field changes
    if (userId) {
      updateData.updatedById = userId;
    }

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

    const response = NextResponse.json(transformedBot);
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
    console.error('Error updating bot:', error);
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

// DELETE /api/bots/:id
// Delete a bot by UUID
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

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

    // Check if bot exists
    const bot = await prisma.bot.findUnique({
      where: { id },
      include: {
        room: true,
      },
    });

    if (!bot) {
      const response = NextResponse.json(
        { error: 'Bot not found' },
        { status: 404 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, bot.roomId);
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

    // Delete bot
    await prisma.bot.delete({
      where: { id },
    });

    // Return 204 No Content on success
    const response = new NextResponse(null, { status: 204 });
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
    console.error('Error deleting bot:', error);
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

