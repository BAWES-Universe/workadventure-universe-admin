import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/emotions
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/:botId/emotions
 * Get bot emotions for admin UI
 * 
 * Auth: Admin
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdminAuth(request);

    const { id: botId } = await params;

    // Query memory table for emotions with user relation
    const memories = await prisma.botsMemory.findMany({
      where: { botId },
      select: {
        userUuid: true,
        userId: true,
        userName: true,
        isGuest: true,
        emotions: true,
        lastEmotionUpdate: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            uuid: true,
          },
        },
      },
    });

    // Format response
    const emotions = memories.map((m) => ({
      userUuid: m.userUuid,
      userId: m.userId,
      userName: m.userName || m.user?.name || null,
      isGuest: m.isGuest,
      user: m.user,
      emotions: m.emotions as any,
      lastEmotionUpdate: m.lastEmotionUpdate?.getTime() || null,
    }));

    return NextResponse.json(emotions, { headers: corsHeaders() });
  } catch (error: any) {
    if (error.message === 'Unauthorized: Admin authentication required') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error getting emotions:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
