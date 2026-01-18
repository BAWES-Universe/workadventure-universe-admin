import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/memory/:botId
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/memory/:botId
 * Enhanced memory save - supports immediate emotion saves
 * 
 * Auth: BOT_SERVICE_TOKEN
 * 
 * Request body:
 * {
 *   "memories": [...],
 *   "timestamp": 1704067200000,
 *   "saveType": "immediate" | "periodic" // New field
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    requireServiceToken(request);

    const { botId } = await params;
    const body = await request.json();

    const {
      memories,
      timestamp,
      saveType = 'periodic', // Default to periodic for backward compatibility
    } = body;

    // For immediate saves (emotion-only updates), we might only have emotions
    // For periodic saves, we have full memory data
    if (!memories && !body.emotions) {
      return NextResponse.json(
        { error: 'memories or emotions required' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Process each memory entry
    const memoryEntries = Array.isArray(memories) ? memories : [];
    
    for (const memory of memoryEntries) {
      const {
        playerId,
        playerName,
        memories: memoryData,
        emotions,
        lastEmotionUpdate,
      } = memory;

      if (!playerId) {
        continue; // Skip invalid entries
      }

      // Upsert memory (update if exists, create if not)
      // Use findUnique with compound key, then update or create
      const existing = await prisma.botsMemory.findUnique({
        where: {
          botId_playerId: {
            botId: botId,
            playerId: Number(playerId),
          },
        },
      });

      if (existing) {
        await prisma.botsMemory.update({
          where: { id: existing.id },
          data: {
            playerName: playerName || undefined,
            memories: memoryData || undefined,
            emotions: emotions || undefined,
            lastEmotionUpdate: lastEmotionUpdate ? new Date(lastEmotionUpdate) : undefined,
            updatedAt: new Date(),
          },
        });
      } else {
        await prisma.botsMemory.create({
          data: {
            botId,
            playerId: Number(playerId),
            playerName: playerName || null,
            memories: memoryData || null,
            emotions: emotions || null,
            lastEmotionUpdate: lastEmotionUpdate ? new Date(lastEmotionUpdate) : null,
          },
        });
      }
    }

    // Handle immediate emotion-only updates (if emotions provided directly)
    if (saveType === 'immediate' && body.emotions && body.playerId) {
      const existing = await prisma.botsMemory.findUnique({
        where: {
          botId_playerId: {
            botId: botId,
            playerId: Number(body.playerId),
          },
        },
      });

      if (existing) {
        await prisma.botsMemory.update({
          where: { id: existing.id },
          data: {
            emotions: body.emotions,
            lastEmotionUpdate: new Date(),
            updatedAt: new Date(),
          },
        });
      } else {
        await prisma.botsMemory.create({
          data: {
            botId,
            playerId: Number(body.playerId),
            playerName: body.playerName || null,
            memories: null,
            emotions: body.emotions,
            lastEmotionUpdate: new Date(),
          },
        });
      }
    }

    return NextResponse.json(
      { status: 'saved', saveType },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error saving memory:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
