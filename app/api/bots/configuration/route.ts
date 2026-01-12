import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { isSuperAdmin } from '@/lib/super-admin';
import { parsePlayUri } from '@/lib/utils';
import { validateAccessToken } from '@/lib/oidc';
import { resolveRoomIdFromPlayUri, transformBotToServerFormat } from '@/lib/bot-config-helpers';
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
 * OPTIONS /api/bots/configuration
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

// Validation schema for creating/updating bot configuration
const botConfigSchema = z.object({
  botId: z.string().uuid().optional(),
  name: z.string().min(1, 'name is required').max(100, 'name must be at most 100 characters'),
  roomUrl: z.string().min(1, 'roomUrl is required'),
  behaviorType: z.enum(['idle', 'patrol', 'social'], {
    message: "behaviorType must be one of: 'idle', 'patrol', 'social'",
  }),
  behaviorConfig: z.record(z.string(), z.any()).optional(),
  enabled: z.boolean().optional().default(true),
  characterTextureIds: z.array(z.string()).optional(),
  description: z.string().optional().nullable(),
  chatInstructions: z.string().optional().nullable(),
  movementInstructions: z.string().optional().nullable(),
  aiProviderRef: z.string().max(100, 'aiProviderRef must be at most 100 characters').optional().nullable(),
});

// Helper function to get user ID from various auth methods
async function getUserIdFromRequest(request: NextRequest): Promise<{ userId: string | null; isAdminToken: boolean; userEmail: string | null }> {
  // PRIORITY 1: Check session token FIRST (from URL param, cookie, or Authorization header)
  // This handles session tokens sent via _token URL param, cookies, or Authorization header
  // Session tokens have 7-day expiration and work even after JWT expires
  const sessionUser = await getSessionUser(request);
  if (sessionUser) {
    return { 
      userId: sessionUser.id, 
      isAdminToken: false,
      userEmail: sessionUser.email,
    };
  }
  
  // PRIORITY 2: Check Authorization header for admin token or OIDC token
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No Bearer token and no session - unauthorized
    return { userId: null, isAdminToken: false, userEmail: null };
  }
  
  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.ADMIN_API_TOKEN;
  
  // Check if it's the admin API token
  if (expectedToken && token === expectedToken) {
    return { userId: null, isAdminToken: true, userEmail: null };
  }
  
  // PRIORITY 3: Try to validate as OIDC token (for initial login/fallback)
  // This will fail if JWT is expired, but that's OK since we already checked session
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
        user = await prisma.user.create({
          data: {
            uuid: identifier,
            email: userInfo.email || null,
            name: userInfo.name || userInfo.preferred_username || null,
            isGuest: false,
          },
        });
      }
      
      return { userId: user.id, isAdminToken: false, userEmail: user.email };
    }
  } catch (error) {
    // Token validation failed - return null (session already checked above)
  }
  
  // No valid authentication found
  return { userId: null, isAdminToken: false, userEmail: null };
}

// GET /api/bots/configuration
// List bot configurations with filtering
export async function GET(request: NextRequest) {
  try {
    // Get user ID from various auth methods
    const { userId, isAdminToken, userEmail } = await getUserIdFromRequest(request);

    if (isAdminToken) {
      // Admin token - require it
      requireAuth(request);
    }

    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const worldUrl = searchParams.get('worldUrl');
    const universeUrl = searchParams.get('universeUrl');
    const userIdParam = searchParams.get('userId');
    const includeSensitive = searchParams.get('includeSensitive') === 'true';

    // Build where clause
    const where: any = {
      enabled: true, // Always filter by enabled = true for list endpoint
    };

    // Filter by roomUrl
    if (roomUrl) {
      try {
        const roomId = await resolveRoomIdFromPlayUri(roomUrl);
        where.roomId = roomId;
      } catch (error) {
        // Invalid roomUrl - return empty array (not error)
        const response = NextResponse.json([]);
        Object.entries(corsHeaders()).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
    }

    // Filter by worldUrl and/or universeUrl
    // Note: roomUrl takes precedence, so if roomUrl is provided, we skip worldUrl/universeUrl filtering
    if (!roomUrl) {
      let worldSlug: string | undefined;
      let universeSlug: string | undefined;

      // Filter by worldUrl
      if (worldUrl) {
        try {
          const parsed = parsePlayUri(worldUrl);
          worldSlug = parsed.world;
          universeSlug = parsed.universe; // worldUrl includes universe
        } catch (error) {
          // Invalid worldUrl - return empty array
          const response = NextResponse.json([]);
          Object.entries(corsHeaders()).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }
      }

      // Filter by universeUrl (if not already set from worldUrl)
      if (universeUrl && !universeSlug) {
        try {
          const parsed = parsePlayUri(universeUrl);
          universeSlug = parsed.universe;
        } catch (error) {
          // Invalid universeUrl - return empty array
          const response = NextResponse.json([]);
          Object.entries(corsHeaders()).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }
      }

      // Build room filter if we have world or universe slugs
      if (worldSlug || universeSlug) {
        where.room = {};
        if (worldSlug) {
          where.room.world = {
            slug: worldSlug,
          };
          if (universeSlug) {
            where.room.world.universe = {
              slug: universeSlug,
            };
          }
        } else if (universeSlug) {
          where.room.world = {
            universe: {
              slug: universeSlug,
            },
          };
        }
      }
    }

    // Filter by userId
    if (userIdParam) {
      where.createdById = userIdParam;
    }

    // Fetch bots with relations
    const bots = await prisma.bot.findMany({
      where,
      include: {
        room: {
          include: {
            world: {
              include: {
                universe: true,
              },
            },
          },
        },
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        updatedBy: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Transform bots to server format
    const transformedBots = await Promise.all(
      bots.map(async (bot) => {
        // Check permission for sensitive data
        let hasPermission = false;
        if (includeSensitive && userId) {
          hasPermission = await canManageBots(userId, bot.roomId) || isSuperAdmin(userEmail);
        }

        return transformBotToServerFormat(bot, includeSensitive, hasPermission);
      })
    );

    // Always return array (even if empty)
    const response = NextResponse.json(transformedBots);
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  } catch (error) {
    console.error('Error fetching bot configurations:', error);
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

// POST /api/bots/configuration
// Create or update bot configuration (upsert)
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
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = botConfigSchema.parse(body);

    // Validate required fields
    if (!validatedData.name || !validatedData.roomUrl || !validatedData.behaviorType) {
      const response = NextResponse.json(
        { error: 'Missing required fields: name, roomUrl, behaviorType' },
        { status: 400 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Resolve roomUrl to roomId
    let roomId: string;
    try {
      roomId = await resolveRoomIdFromPlayUri(validatedData.roomUrl);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid roomUrl format';
      const response = NextResponse.json(
        { error: `Invalid roomUrl: ${errorMessage}` },
        { status: 400 }
      );
      Object.entries(corsHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
    }

    // Check permissions (skip if admin token)
    if (!isAdminToken && userId) {
      const hasPermission = await canManageBots(userId, roomId);
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

    // Prepare behaviorConfig with assignedSpace
    const behaviorConfig = {
      ...(validatedData.behaviorConfig || {}),
      behaviorType: validatedData.behaviorType,
      assignedSpace: validatedData.behaviorConfig?.assignedSpace || {
        center: { x: 0, y: 0 },
        radius: 0,
      },
    };

    // Prepare data for create/update
    const data = {
      name: validatedData.name,
      description: validatedData.description ?? null,
      roomId: roomId,
      characterTextureId: validatedData.characterTextureIds?.[0] || null, // Store first texture
      enabled: validatedData.enabled ?? true,
      behaviorType: validatedData.behaviorType,
      behaviorConfig: behaviorConfig,
      chatInstructions: validatedData.chatInstructions ?? null,
      movementInstructions: validatedData.movementInstructions ?? null,
      aiProviderRef: validatedData.aiProviderRef ?? null,
      updatedById: userId ?? null,
    };

    let bot;
    let statusCode = 201;

    if (validatedData.botId) {
      // Update existing bot
      bot = await prisma.bot.update({
        where: { id: validatedData.botId },
        data: {
          ...data,
          updatedAt: new Date(),
        },
        include: {
          room: {
            include: {
              world: {
                include: {
                  universe: true,
                },
              },
            },
          },
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          updatedBy: {
            select: { id: true, name: true, email: true },
          },
        },
      });
      statusCode = 200;
    } else {
      // Create new bot
      bot = await prisma.bot.create({
        data: {
          ...data,
          createdById: userId ?? null,
        },
        include: {
          room: {
            include: {
              world: {
                include: {
                  universe: true,
                },
              },
            },
          },
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          updatedBy: {
            select: { id: true, name: true, email: true },
          },
        },
      });
    }

    // Transform to server format (include sensitive data for creator)
    const hasPermission = isAdminToken || (userId && await canManageBots(userId, roomId));
    const transformedBot = await transformBotToServerFormat(bot, true, hasPermission);

    const response = NextResponse.json(transformedBot, { status: statusCode });
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
    console.error('Error creating/updating bot configuration:', error);
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

