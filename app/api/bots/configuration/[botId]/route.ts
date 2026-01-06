import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canManageBots } from '@/lib/bot-permissions';
import { isSuperAdmin } from '@/lib/super-admin';
import { validateAccessToken } from '@/lib/oidc';
import { transformBotToServerFormat } from '@/lib/bot-config-helpers';

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
 * OPTIONS /api/bots/configuration/[botId]
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

// Helper function to get user ID from various auth methods
async function getUserIdFromRequest(request: NextRequest): Promise<{ userId: string | null; isAdminToken: boolean; userEmail: string | null }> {
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No Bearer token, try session
    const sessionUser = await getSessionUser(request);
    return { 
      userId: sessionUser?.id || null, 
      isAdminToken: false,
      userEmail: sessionUser?.email || null,
    };
  }
  
  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.ADMIN_API_TOKEN;
  
  // Check if it's the admin API token
  if (expectedToken && token === expectedToken) {
    return { userId: null, isAdminToken: true, userEmail: null };
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
      
      return { userId: user.id, isAdminToken: false, userEmail: user.email };
    }
  } catch (error) {
    // Token validation failed, continue to try session
  }
  
  // Fall back to session
  const sessionUser = await getSessionUser(request);
  return { 
    userId: sessionUser?.id || null, 
    isAdminToken: false,
    userEmail: sessionUser?.email || null,
  };
}

// GET /api/bots/configuration/:botId
// Get single bot configuration
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const { botId } = await params;

    // Get user ID from various auth methods
    const { userId, isAdminToken, userEmail } = await getUserIdFromRequest(request);

    if (isAdminToken) {
      // Admin token - require it
      requireAuth(request);
    }

    const { searchParams } = new URL(request.url);
    const includeSensitive = searchParams.get('includeSensitive') === 'true';

    // Fetch bot with relations
    // NOTE: Do NOT filter by enabled = true - allow fetching disabled bots for editing
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
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

    // Check permission for sensitive data
    let hasPermission = false;
    if (includeSensitive && userId) {
      hasPermission = await canManageBots(userId, bot.roomId) || isSuperAdmin(userEmail);
    }

    // Transform to server format
    const transformedBot = await transformBotToServerFormat(bot, includeSensitive, hasPermission);

    const response = NextResponse.json(transformedBot);
    Object.entries(corsHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  } catch (error) {
    console.error('Error fetching bot configuration:', error);
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

// DELETE /api/bots/configuration/:botId
// Delete bot configuration
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const { botId } = await params;

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

    // Fetch bot to check permissions
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: {
        id: true,
        roomId: true,
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
          { error: 'You do not have permission to delete bots in this room' },
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
      where: { id: botId },
    });

    // Return 204 No Content
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
    console.error('Error deleting bot configuration:', error);
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

