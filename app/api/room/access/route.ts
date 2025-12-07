import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, getClientIp } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { authenticateRequest } from '@/lib/oidc';
import { prisma } from '@/lib/db';
import { validateWokaTextures, validateCompanionTexture } from '@/lib/wokas';
import type { FetchMemberDataByUuidSuccessResponse, ErrorApiData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const userIdentifier = searchParams.get('userIdentifier');
    const playUri = searchParams.get('playUri');
    const ipAddress = searchParams.get('ipAddress') || getClientIp(request);
    const accessToken = searchParams.get('accessToken');
    const chatID = searchParams.get('chatID');
    // WorkAdventure may send name/username for guest users
    const name = searchParams.get('name') || searchParams.get('username');
    
    // Extract characterTextureIds - handle both characterTextureIds and characterTextureIds[]
    // WorkAdventure may send as characterTextureIds[]=value1&characterTextureIds[]=value2
    // URLSearchParams decodes %5B%5D to [], so we need to check for both formats
    let textureIds: string[] = [];
    
    // Collect all parameters that match characterTextureIds (with or without brackets)
    // URLSearchParams automatically decodes, so characterTextureIds%5B%5D becomes characterTextureIds[]
    for (const [key, value] of searchParams.entries()) {
      if (key === 'characterTextureIds' || key === 'characterTextureIds[]') {
        textureIds.push(value);
      }
    }
    
    // If no array params found, try single value
    if (textureIds.length === 0) {
      const singleValue = searchParams.get('characterTextureIds');
      if (singleValue) {
        textureIds = [singleValue];
      }
    }
    
    const companionTextureId = searchParams.get('companionTextureId');
    
    // Debug logging (remove in production)
    // console.log('Received texture IDs:', textureIds);
    // console.log('Received companion texture ID:', companionTextureId);
    // console.log('All search params:', Array.from(searchParams.entries()));
    
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
      
      // Determine name: authenticated user name > query param name > existing name
      const userName = authenticatedUser?.name || name || null;
      // Determine email: authenticated user email > email from identifier > existing email
      const userEmail = authenticatedUser?.email || (userIdentifier.includes('@') ? userIdentifier : null);
      
      if (!user) {
        // Create user if doesn't exist
        user = await prisma.user.create({
          data: {
            uuid: userIdentifier,
            email: userEmail,
            name: userName,
            matrixChatId: chatID || null,
            lastIpAddress: ipAddress || null,
          },
        });
      } else {
        // Update existing user with new information if available
        const updateData: {
          email?: string | null;
          name?: string | null;
          matrixChatId?: string | null;
          lastIpAddress?: string | null;
        } = {};
        
        // Update email if we have a new one and current is null
        if (userEmail && !user.email) {
          updateData.email = userEmail;
        }
        
        // Update name if we have a new one (prefer authenticated, then query param, keep existing if both null)
        if (userName) {
          updateData.name = userName;
        }
        
        // Update matrix chat ID if provided (may change over time)
        if (chatID) {
          updateData.matrixChatId = chatID;
        }
        
        // Always update IP address to track last known IP
        if (ipAddress) {
          updateData.lastIpAddress = ipAddress;
        }
        
        // Only update if we have changes
        if (Object.keys(updateData).length > 0) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });
        }
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
      
      // Get play service URL for texture validation
      const playServiceUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
      
      // Validate character textures against available Wokas
      const textureValidation = await validateWokaTextures(textureIds, playServiceUrl);
      
      // Validate companion texture if provided
      const companionValidation = await validateCompanionTexture(
        companionTextureId,
        playServiceUrl
      );
      
      // Get user avatar (for fallback or additional data)
      const avatar = await prisma.userAvatar.findUnique({
        where: {
          userId_worldId: {
            userId: user.id,
            worldId: worldData.id,
          },
        },
      });
      
      // If textures are invalid and we have stored avatar textures, use them as fallback
      let finalTextures = textureValidation.textures;
      let isTexturesValid = textureValidation.valid;
      
      if (!isTexturesValid && avatar?.textureIds && avatar.textureIds.length > 0) {
        // Try to validate stored textures as fallback
        const fallbackValidation = await validateWokaTextures(avatar.textureIds, playServiceUrl);
        if (fallbackValidation.valid) {
          finalTextures = fallbackValidation.textures;
          isTexturesValid = true;
        }
      }
      
      // Handle companion texture - use stored one if provided one is invalid
      let finalCompanionTexture = companionValidation.texture;
      let isCompanionValid = companionValidation.valid;
      
      if (!isCompanionValid && avatar?.companionTextureId) {
        const fallbackCompanion = await validateCompanionTexture(
          avatar.companionTextureId,
          playServiceUrl
        );
        if (fallbackCompanion.valid) {
          finalCompanionTexture = fallbackCompanion.texture;
          isCompanionValid = true;
        }
      }
      
      // Build response
      const response: FetchMemberDataByUuidSuccessResponse = {
        status: "ok",
        email: user.email,
        username: user.name || undefined,
        userUuid: user.uuid,
        tags: membership.tags,
        visitCardUrl: null,
        isCharacterTexturesValid: isTexturesValid,
        characterTextures: finalTextures,
        isCompanionTextureValid: isCompanionValid,
        companionTexture: finalCompanionTexture,
        messages: [],
        userRoomToken: "",
        activatedInviteUser: true,
        applications: [],
        canEdit: membership.tags.includes('editor') || membership.tags.includes('admin'),
        world: world,
        chatID: chatID || user.matrixChatId || undefined,
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

