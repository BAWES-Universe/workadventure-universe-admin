import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import { checkWamExists, createWamFile, getWamUrl, getWamPath } from '@/lib/map-storage';
import type { MapDetailsData, ErrorApiData, RoomRedirect } from '@/types/workadventure';

// Ensure this route runs in Node.js runtime (not Edge) to support Redis and Prisma
export const runtime = 'nodejs';

/**
 * Returns the base start map configuration
 * Used as fallback when no room is found or room has no mapUrl
 * Note: group is required and can be null for base start map
 */
function getBaseStartMap(authToken?: string | null): MapDetailsData {
  const startRoomUrl = process.env.BASE_START_MAP_URL || process.env.START_ROOM_URL || 'https://rveiio.github.io/BAWES-virtual/office.tmj';
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
    
    // Handle root path - redirect to START_ROOM_URL
    try {
      const roomUrl = new URL(playUri);
      if (roomUrl.pathname === "/" || roomUrl.pathname === "") {
        const startRoomPath = process.env.START_ROOM_URL || '@/default/default/default';
        
        // Construct redirect URL
        let redirectUrl: string;
        if (startRoomPath.startsWith('http://') || startRoomPath.startsWith('https://')) {
          // If it's already a full URL, use it directly
          redirectUrl = startRoomPath;
        } else if (startRoomPath.startsWith('@/')) {
          // If it's a playUri path, construct full URL from playUri's origin
          roomUrl.pathname = `/${startRoomPath}`;
          redirectUrl = roomUrl.toString();
        } else {
          // If it's a relative path, prepend with /
          const path = startRoomPath.startsWith('/') ? startRoomPath : `/${startRoomPath}`;
          roomUrl.pathname = path;
          redirectUrl = roomUrl.toString();
        }
        
        const redirect: RoomRedirect = {
          redirectUrl: redirectUrl,
        };
        return NextResponse.json(redirect);
      }
    } catch (urlError) {
      // If playUri is not a valid URL, continue to parsePlayUri which will handle the error
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
              universe: {
                include: {
                  owner: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                    },
                  },
                },
              },
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
      
      // Always recompute wamUrl from current environment variable when map-storage is configured
      // Don't trust stored database value as PUBLIC_MAP_STORAGE_URL may have changed
      let wamUrl: string | undefined = undefined;
      
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
          // WAM exists, always use computed URL (don't trust stored database value)
          wamUrl = computedWamUrl;
          
          // Update database if stored URL is different (to keep it in sync)
          if (roomData.wamUrl !== computedWamUrl) {
            try {
              await prisma.room.update({
                where: { id: roomData.id },
                data: { wamUrl: computedWamUrl } as any,
              });
            } catch (updateError) {
              // Log but don't fail - the URL is correct for this request
              console.warn('Failed to update wamUrl in database:', updateError);
            }
          }
        }
      }
      
      // Step 7: Return MapDetailsData with wamUrl prioritized over mapUrl
      const editable = wamUrl !== undefined && wamUrl.includes('map-storage');
      const group = `${roomData.world.universe.slug}/${roomData.world.slug}`;
      
      // Check if user is authenticated (if authToken/accessToken is provided)
      const isAuthenticated = !!authToken;
      
      // Get universe owner name for author field
      const universeOwner = roomData.world.universe.owner;
      const authorName = universeOwner?.name || universeOwner?.email || "Universe";
      
      // Construct base URL for assets (assets are served from this admin API project)
      let baseUrl: string;
      // First try NEXT_PUBLIC_API_URL if set
      if (process.env.NEXT_PUBLIC_API_URL) {
        baseUrl = process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, ''); // Remove trailing slash
      } else {
        // Otherwise, construct from the request URL (this API endpoint's origin)
        try {
          const requestUrl = new URL(request.url);
          baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
        } catch {
          // Final fallback for local development
          baseUrl = "http://admin.bawes.localhost:8321";
        }
      }
      
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
        metatags: {
          title: "Universe | " + roomData.world.universe.name + " > " + roomData.world.name + " > " + roomData.name,
          description: "Join the " + roomData.name + " room in the " + roomData.world.name + " world of the " + roomData.world.universe.name + " universe. Collaborate, connect, and work together in an immersive environment.",
          author: authorName,
          provider: "Universe",
          cardImage: `${baseUrl}/assets/cardimage-1500x500.png`,
          favIcons: [
            {
              rel: "icon",
              sizes: "512x512",
              src: `${baseUrl}/assets/favicon-trans-512x512.png`,
            },
            {
              rel: "apple-touch-icon",
              sizes: "180x180",
              src: `${baseUrl}/assets/logo-ios-180x180.png`,
            }
          ],
          manifestIcons: [
            {
              src: `${baseUrl}/assets/favicon-512x512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: `${baseUrl}/assets/favicon-512x512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: `${baseUrl}/assets/favicon-512x512.png`,
              sizes: "192x192",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: `${baseUrl}/assets/favicon-512x512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            }
          ],
          appName: "Universe",
          shortAppName: "Universe",
          themeColor: "#000000"
        },
        group: group,
        policy: roomData.isPublic ? "public" : "private",

        showPoweredBy: false,
        backgroundColor: "#000000",
        primaryColor: "#4056F6",
        backgroundSceneImage: `${baseUrl}/assets/background-1920x1080.png`,
        errorSceneLogo: `${baseUrl}/assets/logo-300x250.png`,
        loadingLogo: `${baseUrl}/assets/loading-logo.png`,
        loginSceneLogo: `${baseUrl}/assets/logo-300x150.png`,
        
        // Include modules array to tell WorkAdventure which modules to load
        modules: isAuthenticated ? ["admin-api","teleport","bots"] : ["teleport","bots"],
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

