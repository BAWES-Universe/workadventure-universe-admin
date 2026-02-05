import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken, validateServiceToken } from '@/lib/service-tokens';
import { requireAdminAuth } from '@/lib/admin-auth';
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
 * GET /api/bots/memory/:botId
 * Return all memory entries for a bot (for restore on startup).
 *
 * Auth: BOT_SERVICE_TOKEN or ADMIN_API_TOKEN / session
 *
 * Query params (optional):
 * - userUuid: return only memory for this user
 *
 * Response: { memories: [...] } — same shape as POST accepts (read instead of write).
 * Returns 200 with { memories: [] } when bot has no memories.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const isServiceToken = validateServiceToken(request);
    if (!isServiceToken) {
      await requireAdminAuth(request);
    }

    const { id: botId } = await params;
    const { searchParams } = new URL(request.url);
    const userUuidFilter = searchParams.get('userUuid');

    const where: { botId: string; userUuid?: string } = { botId };
    if (userUuidFilter) {
      where.userUuid = userUuidFilter;
    }

    const rows = await prisma.botsMemory.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    const memories = rows.map((row) => {
      const rawEmotions = (row.emotions as Record<string, unknown> | null) || {};
      const lastEmotionMs = row.lastEmotionUpdate
        ? row.lastEmotionUpdate.getTime()
        : undefined;
      const emotions =
        Object.keys(rawEmotions).length > 0 || lastEmotionMs !== undefined
          ? { ...rawEmotions, ...(lastEmotionMs !== undefined && { lastEmotionUpdate: lastEmotionMs }) }
          : null;

      return {
        userUuid: row.userUuid,
        userId: row.userId ?? null,
        userName: row.userName ?? null,
        isGuest: row.isGuest,
        memories: row.memories ?? null,
        emotions,
      };
    });

    return NextResponse.json(
      { memories },
      { status: 200, headers: corsHeaders() }
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.message?.includes('Unauthorized')) {
      return NextResponse.json(
        { error: 'Unauthorized', details: 'Invalid or missing token' },
        { status: 401, headers: corsHeaders() }
      );
    }
    console.error('Error in GET /api/bots/memory/:botId:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}

/**
 * POST /api/bots/memory/:botId
 * Enhanced memory save - supports immediate emotion saves and full memory storage
 * 
 * Auth: BOT_SERVICE_TOKEN
 * 
 * Request body:
 * {
 *   "memories": [...],  // Array of memory entries (for periodic saves)
 *   "memory" | "memories" | "memoryData": {...},  // Full memory object (for immediate saves)
 *   "emotions": {...},  // Emotion data
 *   "timestamp": 1704067200000,
 *   "saveType": "immediate" | "periodic"  // Metadata only - full memory is always stored when provided
 * }
 * 
 * Note: saveType is metadata for logging/analytics. The full memory_data JSONB is always
 * stored when provided, regardless of saveType value.
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

    // Both immediate and periodic saves can include full memory data
    // saveType is just metadata - we always store full memory when provided
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

          // Try to match userUuid to User table
          let finalUserId: string | null = userId || null;
          let finalIsGuest = true;

          // Check if userUuid looks like an email
          const isEmail = userUuid.includes('@');

          // Only try to match if user is logged in (isGuest = false) OR if userUuid is an email
          // (emails are always from authenticated users, even if isGuest flag is wrong)
          if (!isGuest || isEmail) {
            try {
              let user = null;
              
              if (isEmail) {
                // OIDC case: Look up by email
                user = await prisma.user.findUnique({
                  where: { email: userUuid },
                  select: { id: true, uuid: true },
                });
              } else {
                // Normal case: Look up by UUID
                user = await prisma.user.findUnique({
                  where: { uuid: userUuid },
                  select: { id: true, uuid: true },
                });
              }
              
              if (user) {
                finalUserId = user.id;
                finalIsGuest = false;
              } else {
                // User not found - treat as guest
                finalIsGuest = true;
                if (process.env.NODE_ENV === 'development') {
                  if (isEmail) {
                    console.warn(`User email ${userUuid} not found in database, treating as guest`);
                  } else {
                    console.warn(`User UUID ${userUuid} not found in database, treating as guest`);
                  }
                }
              }
            } catch (err) {
              // Database error during lookup - log but continue as guest
              console.error(`Error looking up user (email/uuid: ${userUuid}):`, err);
              finalIsGuest = true;
            }
          } else {
            // Guest user (isGuest = true and not an email) - no lookup needed
            finalIsGuest = true;
          }

          // If userId was explicitly provided, trust it (but still set isGuest correctly)
          if (userId) {
            finalUserId = userId;
            // If userId provided, user is authenticated
            if (!finalIsGuest) {
              // Already set to false above
            } else {
              // userId provided but lookup failed - trust the userId
              finalIsGuest = false;
            }
          }

          // Always store userUuid (even for guests with no match)
          // This allows us to track ephemeral guest sessions
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

        // Handle immediate emotion updates (if emotions provided directly)
        // IMPORTANT: Always store full memory data when provided, regardless of saveType
        // saveType is just metadata for logging/analytics, not a signal to skip storing full memory
        if (saveType === 'immediate' && body.emotions && body.userUuid) {
          // Try to match userUuid to User table
          let finalUserId: string | null = body.userId || null;
          let finalIsGuest = true;

          // Check if userUuid looks like an email
          const isEmail = body.userUuid.includes('@');

          // Only try to match if user is logged in (isGuest = false) OR if userUuid is an email
          // (emails are always from authenticated users, even if isGuest flag is wrong)
          if (body.isGuest === false || isEmail) {
            try {
              let user = null;
              
              if (isEmail) {
                // OIDC case: Look up by email
                user = await prisma.user.findUnique({
                  where: { email: body.userUuid },
                  select: { id: true, uuid: true },
                });
              } else {
                // Normal case: Look up by UUID
                user = await prisma.user.findUnique({
                  where: { uuid: body.userUuid },
                  select: { id: true, uuid: true },
                });
              }
              
              if (user) {
                finalUserId = user.id;
                finalIsGuest = false;
              } else {
                // User not found - treat as guest
                finalIsGuest = true;
                if (process.env.NODE_ENV === 'development') {
                  if (isEmail) {
                    console.warn(`User email ${body.userUuid} not found in database, treating as guest`);
                  } else {
                    console.warn(`User UUID ${body.userUuid} not found in database, treating as guest`);
                  }
                }
              }
            } catch (err) {
              // Database error during lookup - log but continue as guest
              console.error(`Error looking up user (email/uuid: ${body.userUuid}):`, err);
              finalIsGuest = true;
            }
          } else {
            // Guest user (isGuest = true and not an email) - no lookup needed
            finalIsGuest = true;
          }

          // If userId was explicitly provided, trust it (but still set isGuest correctly)
          if (body.userId) {
            finalUserId = body.userId;
            // If userId provided, user is authenticated
            if (!finalIsGuest) {
              // Already set to false above
            } else {
              // userId provided but lookup failed - trust the userId
              finalIsGuest = false;
            }
          }

          // Extract full memory data if provided (bot sends full memory object even with immediate saves)
          // Check for memory data in various possible formats:
          // 1. First check the memories array for matching userUuid (most common format)
          // 2. Then check top-level fields: body.memories, body.memory, body.memoryData
          let fullMemoryData = null;
          
          // Check memories array first (bot often sends full memory in array format)
          if (Array.isArray(memories) && memories.length > 0) {
            const matchingMemory = memories.find((m: any) => m.userUuid === body.userUuid);
            if (matchingMemory && matchingMemory.memories) {
              fullMemoryData = matchingMemory.memories;
            }
          }
          
          // Fallback to top-level fields if not found in array
          if (!fullMemoryData) {
            fullMemoryData = body.memories || body.memory || body.memoryData || null;
          }

          await prisma.botsMemory.upsert({
            where: {
              botId_userUuid: {
                botId: botId,
                userUuid: body.userUuid,
              },
            },
            update: {
              // Always update emotions when provided
              emotions: body.emotions,
              // Always update full memory data when provided (regardless of saveType)
              memories: fullMemoryData !== null ? fullMemoryData : undefined,
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
              // Store full memory data if provided, otherwise null
              memories: fullMemoryData,
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
