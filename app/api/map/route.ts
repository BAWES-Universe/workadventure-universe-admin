import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import { checkWamExists, createWamFile, getWamUrl, getWamPath } from '@/lib/map-storage';
import type { MapDetailsData, ErrorApiData } from '@/types/workadventure';

// Ensure this route runs in Node.js runtime (not Edge) to support Redis and Prisma
export const runtime = 'nodejs';

/**
 * Returns the base start map configuration
 * Used as fallback when no room is found or room has no mapUrl
 * Note: group is required and can be null for base start map
 */
function getBaseStartMap(authToken?: string | null): MapDetailsData {
  const startRoomUrl = process.env.START_ROOM_URL || 'https://rveiio.github.io/BAWES-virtual/office.tmj';
  const isAuthenticated = !!authToken;
  
  return {
    mapUrl: startRoomUrl,
    group: null, // Required field - null for base start map
    editable: false,
    authenticationMandatory: false,
    policy: "public",
    // Include modules array to tell WorkAdventure which modules to load
    modules: isAuthenticated ? ["admin-api"] : [],
    // Include metadata (optional, gets passed to extension module's init function)
    ...(isAuthenticated && {
      metadata: {
        modules: ["admin-api"],
      },
    }),
  };
}

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');
    const authToken = searchParams.get('authToken') || searchParams.get('accessToken');
    
    if (!playUri) {
      const error: ErrorApiData = {
        status: "error",
        type: "error",
        title: "Missing parameter",
        subtitle: "playUri is required",
        code: "MISSING_PLAY_URI",
        details: "The playUri query parameter is required.",
      };
      return NextResponse.json(error, { status: 400 });
    }
    
    try {
      // Step 1: Parse playUri to extract universe/world/room/domain
      const { universe: universeSlug, world: worldSlug, room: roomSlug, domain } = parsePlayUri(playUri);
      
      // Step 2: Query database for room with map configuration
      const roomData = await prisma.room.findFirst({
        where: {
          slug: roomSlug,
          world: {
            slug: worldSlug,
            universe: {
              slug: universeSlug,
            },
          },
        },
        include: {
          world: {
            include: {
              universe: true,
            },
          },
        },
      });
      
      // Step 3: If room not found or no mapUrl, return base start map
      if (!roomData || !roomData.mapUrl) {
        return NextResponse.json(getBaseStartMap(authToken));
      }
      
      // Step 4-6: Prepare map-storage paths and check/create WAM file
      const publicMapStorageUrl = process.env.PUBLIC_MAP_STORAGE_URL;
      const mapStorageApiToken = process.env.MAP_STORAGE_API_TOKEN;
      const playUrl = process.env.PLAY_URL;
      
      let wamUrl: string | undefined = roomData.wamUrl;
      
      // Only proceed with WAM creation if map-storage is configured
      if (publicMapStorageUrl && mapStorageApiToken && playUrl) {
        const wamPath = getWamPath(domain, universeSlug, worldSlug, roomSlug);
        const computedWamUrl = getWamUrl(domain, universeSlug, worldSlug, roomSlug, publicMapStorageUrl);
        
        // Check if WAM exists in map-storage
        const wamExists = await checkWamExists(publicMapStorageUrl, wamPath, mapStorageApiToken);
        
        // If WAM doesn't exist and mapUrl exists, create WAM via PUT
        if (!wamExists && roomData.mapUrl) {
          try {
            await createWamFile(
              publicMapStorageUrl,
              wamPath,
              roomData.mapUrl, // External TMJ URL
              mapStorageApiToken,
              playUrl
            );
            
            // Update room with wamUrl in database
            await prisma.room.update({
              where: { id: roomData.id },
              data: { wamUrl: computedWamUrl } as any,
            });
            
            wamUrl = computedWamUrl;
          } catch (wamError) {
            // Log error but continue with mapUrl as fallback
            console.error('Failed to create WAM file, using mapUrl as fallback:', wamError);
          }
        } else if (wamExists) {
          // WAM exists, use computed URL if room doesn't have it stored
          wamUrl = wamUrl || computedWamUrl;
        }
      }
      
      // Step 7: Return MapDetailsData with wamUrl prioritized over mapUrl
      const editable = wamUrl !== undefined && wamUrl.includes('map-storage');
      const group = `${roomData.world.universe.slug}/${roomData.world.slug}`;
      
      // Check if user is authenticated (if authToken/accessToken is provided)
      const isAuthenticated = !!authToken;
      
      // Prioritize wamUrl: if WAM exists, return it (WorkAdventure prefers wamUrl over mapUrl)
      // Only include mapUrl as fallback if wamUrl is not available
      const mapDetails: MapDetailsData = {
        // Include wamUrl if available (takes precedence)
        ...(wamUrl && { wamUrl: wamUrl }),
        // Only include mapUrl if wamUrl is not available (as fallback)
        ...(!wamUrl && { mapUrl: roomData.mapUrl }),
        editable: editable,
        authenticationMandatory: roomData.authenticationMandatory || false,
        roomName: roomData.name,
        group: group,
        policy: roomData.isPublic ? "public" : "private",
        // Include modules array to tell WorkAdventure which modules to load
        modules: isAuthenticated ? ["admin-api"] : [],
        // Include metadata (optional, gets passed to extension module's init function)
        ...(isAuthenticated && {
          metadata: {
            modules: ["admin-api"],
          },
        }),
      };
      
      return NextResponse.json(mapDetails);
    } catch (parseError) {
      // If playUri parsing fails, return base start map instead of error
      // This handles root URL access or invalid paths gracefully
      if (parseError instanceof Error && parseError.message.includes('Invalid playUri')) {
        const { searchParams } = new URL(request.url);
        const authToken = searchParams.get('authToken') || searchParams.get('accessToken');
        return NextResponse.json(getBaseStartMap(authToken));
      }
      
      const error: ErrorApiData = {
        status: "error",
        type: "error",
        title: "Invalid playUri",
        subtitle: "The playUri format is invalid",
        code: "INVALID_PLAY_URI",
        details: parseError instanceof Error ? parseError.message : "Invalid playUri format.",
      };
      return NextResponse.json(error, { status: 400 });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      const errorResponse: ErrorApiData = {
        status: "error",
        type: "unauthorized",
        title: "Unauthorized",
        subtitle: "Invalid or missing authentication token",
        code: "UNAUTHORIZED",
        details: "Please provide a valid Bearer token in the Authorization header",
      };
      return NextResponse.json(errorResponse, { status: 401 });
    }
    
    console.error('Error in /api/map:', error);
    
    // On unexpected errors, return base start map as fallback
    const { searchParams } = new URL(request.url);
    const authToken = searchParams.get('authToken') || searchParams.get('accessToken');
    return NextResponse.json(getBaseStartMap(authToken));
  }
}

