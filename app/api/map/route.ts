import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import type { MapDetailsData, RoomRedirect, ErrorApiData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');
    
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
      const { universe, world, room } = parsePlayUri(playUri);
      
      // Find the room in the database
      const roomData = await prisma.room.findFirst({
        where: {
          slug: room,
          world: {
            slug: world,
            universe: {
              slug: universe,
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
      
      if (!roomData) {
        const error: ErrorApiData = {
          status: "error",
          type: "error",
          title: "Map not found",
          subtitle: "The requested map does not exist",
          code: "MAP_NOT_FOUND",
          details: `The map for room ${universe}/${world}/${room} could not be found.`,
        };
        return NextResponse.json(error, { status: 404 });
      }
      
      // Return map details
      const mapDetails: MapDetailsData = {
        mapUrl: roomData.mapUrl || roomData.world.mapUrl || '',
        wamSettings: roomData.world.wamUrl ? {
          wamUrl: roomData.world.wamUrl,
        } : undefined,
        policy: roomData.isPublic ? "public" : "private",
        roomName: roomData.name,
        authenticationMandatory: false,
      };
      
      return NextResponse.json(mapDetails);
    } catch (parseError) {
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
    const errorResponse: ErrorApiData = {
      status: "error",
      type: "error",
      title: "Internal server error",
      subtitle: "An unexpected error occurred",
      code: "INTERNAL_ERROR",
      details: "An error occurred while processing your request.",
    };
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

