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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireServiceToken(request);

    const { id: botId } = await params;
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

    // Validate that memories array has userUuid if provided
    if (memories && Array.isArray(memories)) {
      for (const memory of memories) {
        if (!memory.userUuid) {
          return NextResponse.json(
            { error: 'userUuid is required for each memory entry' },
            { status: 400, headers: corsHeaders() }
          );
        }
      }
    }

    // Validate userUuid for immediate emotion updates
    if (saveType === 'immediate' && body.emotions && !body.userUuid) {
      return NextResponse.json(
        { error: 'userUuid is required for immediate emotion updates' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Process each memory entry
    const memoryEntries = Array.isArray(memories) ? memories : [];
    
    // Process memories asynchronously (fire-and-forget pattern)
    (async () => {
      try {
        for (const memory of memoryEntries) {
          const {
            userUuid,      // REQUIRED - WorkAdventure UUID
            userId,        // Optional - User.id if authenticated
            userName,      // Optional - Display name
            isGuest,       // Optional - true if not authenticated
            isLogged,      // Alternative field from bot server
            memories: memoryData,
            emotions,
            lastEmotionUpdate,
          } = memory;

          if (!userUuid) {
            console.warn('Skipping memory entry without userUuid:', memory);
            continue; // Skip invalid entries
          }

          // Determine if user is logged in
          const userIsLogged = isGuest === false || isLogged === true;

          // Try to match userUuid to User table if user is logged in
          let finalUserId: string | null = userId || null;
          let finalIsGuest = true;

          if (userIsLogged) {
            try {
              const user = await prisma.user.findUnique({
                where: { uuid: userUuid },
                select: { id: true },
              });

              if (user) {
                finalUserId = user.id;
                finalIsGuest = false;
              } else if (finalUserId) {
                // userId was provided but UUID doesn't match - use provided userId but log warning
                console.warn(`User UUID ${userUuid} not found, but userId ${finalUserId} was provided`);
                finalIsGuest = false;
              } else {
                // User claims to be logged in but UUID not found - treat as guest
                console.warn(`User UUID ${userUuid} not found in database, treating as guest despite isGuest=false`);
                finalIsGuest = true;
              }
            } catch (err) {
              // Database error during lookup - log but continue with provided userId if available
              console.error(`Error looking up user with uuid ${userUuid}:`, err);
              if (finalUserId) {
                finalIsGuest = false;
              }
            }
          } else if (finalUserId) {
            // If userId was provided but user is marked as guest, trust the userId
            finalIsGuest = false;
          }

          // Upsert memory using botId + userUuid unique constraint
          await prisma.botsMemory.upsert({
            where: {
              botId_userUuid: {
                botId: botId,
                userUuid: userUuid,
              },
            },
            update: {
              userId: finalUserId,
              userName: userName || undefined,
              isGuest: finalIsGuest,
              memories: memoryData || undefined,
              emotions: emotions || undefined,
              lastEmotionUpdate: lastEmotionUpdate ? new Date(lastEmotionUpdate) : undefined,
              updatedAt: new Date(),
            },
            create: {
              botId,
              userUuid,
              userId: finalUserId,
              userName: userName || null,
              isGuest: finalIsGuest,
              memories: memoryData || null,
              emotions: emotions || null,
              lastEmotionUpdate: lastEmotionUpdate ? new Date(lastEmotionUpdate) : null,
            },
          });
        }

        // Handle immediate emotion-only updates (if emotions provided directly)
        if (saveType === 'immediate' && body.emotions && body.userUuid) {
          // Try to match UUID for immediate emotion updates
          let finalUserId: string | null = body.userId || null;
          let finalIsGuest = true;

          if (body.isGuest === false || body.isLogged === true) {
            try {
              const user = await prisma.user.findUnique({
                where: { uuid: body.userUuid },
                select: { id: true },
              });

              if (user) {
                finalUserId = user.id;
                finalIsGuest = false;
              }
            } catch (err) {
              console.error(`Error looking up user with uuid ${body.userUuid}:`, err);
            }
          }

          await prisma.botsMemory.upsert({
            where: {
              botId_userUuid: {
                botId: botId,
                userUuid: body.userUuid,
              },
            },
            update: {
              emotions: body.emotions,
              userId: finalUserId,
              userName: body.userName || undefined,
              isGuest: finalIsGuest,
              lastEmotionUpdate: new Date(),
              updatedAt: new Date(),
            },
            create: {
              botId,
              userUuid: body.userUuid,
              userId: finalUserId,
              userName: body.userName || null,
              isGuest: finalIsGuest,
              memories: null,
              emotions: body.emotions,
              lastEmotionUpdate: new Date(),
            },
          });
        }
      } catch (err) {
        // Log error but don't block response (fire-and-forget)
        console.error('Error processing memory entries:', err);
      }
    })();

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
