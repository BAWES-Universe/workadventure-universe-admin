import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateServiceToken } from '@/lib/service-tokens';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * GET /api/bots/ai-providers
 * List available AI providers
 * 
 * Auth: Service token OR session token (super admin for admin UI)
 * Query params: enabled (boolean), type (string)
 */
export async function GET(request: NextRequest) {
  try {
    // Check authentication - either service token or super admin session
    const isServiceToken = validateServiceToken(request);
    let isAuthorized = isServiceToken;

    if (!isServiceToken) {
      // Try session token (for admin UI)
      const sessionUser = await getSessionUser(request);
      if (sessionUser && isSuperAdmin(sessionUser.email)) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const enabledParam = searchParams.get('enabled');
    const typeParam = searchParams.get('type');

    // Build where clause
    const where: any = {};
    if (enabledParam !== null) {
      where.enabled = enabledParam === 'true';
    }
    if (typeParam) {
      where.type = typeParam;
    }

    const providers = await prisma.botsAiProvider.findMany({
      where,
      select: {
        providerId: true,
        name: true,
        type: true,
        enabled: true,
        supportsStreaming: true,
        // Do NOT return credentials or sensitive data
      },
      orderBy: {
        name: 'asc',
      },
    });

    return NextResponse.json(providers);
  } catch (error) {
    console.error('Error listing AI providers:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

