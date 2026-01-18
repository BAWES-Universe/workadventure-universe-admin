import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/conversations/stats
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/:botId/conversations/stats
 * Get conversation statistics
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

    // Get stats
    const [totalConversations, oldest, newest] = await Promise.all([
      prisma.botsConversation.count({
        where: { botId },
      }),
      prisma.botsConversation.findFirst({
        where: { botId },
        orderBy: { endedAt: 'asc' },
        select: { endedAt: true },
      }),
      prisma.botsConversation.findFirst({
        where: { botId },
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      }),
    ]);

    // Calculate total size (approximate - sum of message counts)
    const sizeResult = await prisma.botsConversation.aggregate({
      where: { botId },
      _sum: {
        messageCount: true,
      },
    });

    return NextResponse.json(
      {
        botId,
        totalConversations,
        oldestConversation: oldest?.endedAt.getTime() || null,
        newestConversation: newest?.endedAt.getTime() || null,
        totalSize: sizeResult._sum.messageCount || 0,
      },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Admin authentication required') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error getting conversation stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
