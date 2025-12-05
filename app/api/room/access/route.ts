import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, getClientIp } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { authenticateRequest } from '@/lib/oidc';
import { prisma } from '@/lib/db';
import type { FetchMemberDataByUuidSuccessResponse, ErrorApiData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const userIdentifier = searchParams.get('userIdentifier');
    const playUri = searchParams.get('playUri');
    const ipAddress = searchParams.get('ipAddress') || getClientIp(request);
    const accessToken = searchParams.get('accessToken');
    
    if (!userIdentifier || !playUri) {
      const error: ErrorApiData = {
        status: "error",
        type: "error",
        title: "Missing parameters",
        subtitle: "userIdentifier and playUri are required",
        code: "MISSING_PARAMETERS",
        details: "The userIdentifier and playUri query parameters are required.",
      };
      return NextResponse.json(error, { status: 400 });
    }
    
    try {
      const { universe, world, room } = parsePlayUri(playUri);
      
      // Authenticate user if access token provided
      let authenticatedUser = null;
      if (accessToken) {
        authenticatedUser = await authenticateRequest(request);
      }
      
      // Find or create user
      let user = await prisma.user.findFirst({
        where: {
          OR: [
            { uuid: userIdentifier },
            { email: userIdentifier },
          ],
        },
      });
      
      if (!user) {
        // Create user if doesn't exist
        user = await prisma.user.create({
          data: {
            uuid: userIdentifier,
            email: authenticatedUser?.email || (userIdentifier.includes('@') ? userIdentifier : null),
            name: authenticatedUser?.name || null,
          },
        });
      }
      
      // Find world
      const worldData = await prisma.world.findFirst({
        where: {
          slug: world,
          universe: {
            slug: universe,
          },
        },
      });
      
      if (!worldData) {
        const error: ErrorApiData = {
          status: "error",
          type: "error",
          title: "World not found",
          subtitle: "The requested world does not exist",
          code: "WORLD_NOT_FOUND",
          details: `The world ${universe}/${world} could not be found.`,
        };
        return NextResponse.json(error, { status: 404 });
      }
      
      // Check if user is banned
      const ban = await prisma.ban.findFirst({
        where: {
          isActive: true,
          AND: [
            {
              OR: [
                { userId: user.id },
                { ipAddress: ipAddress },
              ],
            },
            {
              OR: [
                { worldId: worldData.id },
                { universeId: worldData.universeId },
                { worldId: null, universeId: null }, // Global ban
              ],
            },
            {
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: new Date() } },
              ],
            },
          ],
        },
      });
      
      if (ban) {
        const error: ErrorApiData = {
          status: "error",
          type: "unauthorized",
          title: "Access denied",
          subtitle: "You have been banned",
          code: "BANNED",
          details: ban.reason || "You have been banned from this world.",
        };
        return NextResponse.json(error, { status: 403 });
      }
      
      // Get or create world membership
      let membership = await prisma.worldMember.findUnique({
        where: {
          userId_worldId: {
            userId: user.id,
            worldId: worldData.id,
          },
        },
      });
      
      if (!membership) {
        // Create membership with default tags
        membership = await prisma.worldMember.create({
          data: {
            userId: user.id,
            worldId: worldData.id,
            tags: authenticatedUser?.tags || [],
          },
        });
      }
      
      // Get user avatar
      const avatar = await prisma.userAvatar.findUnique({
        where: {
          userId_worldId: {
            userId: user.id,
            worldId: worldData.id,
          },
        },
      });
      
      // Build response
      const response: FetchMemberDataByUuidSuccessResponse = {
        status: "ok",
        email: user.email,
        username: user.name || undefined,
        userUuid: user.uuid,
        tags: membership.tags,
        visitCardUrl: null,
        isCharacterTexturesValid: !!avatar && avatar.textureIds.length > 0,
        characterTextures: avatar?.textureIds.map((id: string) => ({
          id,
          url: `https://example.com/wokas/${id}.png`, // TODO: Replace with actual URL
          layer: [],
        })) || [],
        isCompanionTextureValid: !!avatar?.companionTextureId,
        companionTexture: avatar?.companionTextureId ? {
          id: avatar.companionTextureId,
          url: `https://example.com/companions/${avatar.companionTextureId}.png`, // TODO: Replace with actual URL
        } : null,
        messages: [],
        userRoomToken: "",
        activatedInviteUser: true,
        applications: [],
        canEdit: membership.tags.includes('editor') || membership.tags.includes('admin'),
        world: world,
        chatID: user.matrixChatId || undefined,
      };
      
      return NextResponse.json(response);
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
    
    console.error('Error in /api/room/access:', error);
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

