import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, getClientIp } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { authenticateRequest } from '@/lib/oidc';
import { prisma } from '@/lib/db';
import { validateWokaTextures, validateCompanionTexture } from '@/lib/wokas';
import { notifyRoomAccess } from '@/lib/discord';
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
      
      // Authenticate user - always call authenticateRequest to get proper status
      // It will return null (if Bearer token invalid) or an object with isAuthenticated flag
      let authenticatedUser = await authenticateRequest(request);
      
      // Determine if this is a guest user (no authentication)
      // Guest = no accessToken in query params OR authenticateRequest returned null OR isAuthenticated is false
      // Note: authenticateRequest returns {isAuthenticated: false} when no accessToken is provided
      const isGuest = !accessToken || !authenticatedUser || !authenticatedUser.isAuthenticated;
      
      // Find or create user
      // First, try to find by authenticated user identifier (if authenticated)
      let user = null;
      if (authenticatedUser?.isAuthenticated && authenticatedUser.identifier) {
        // For authenticated users, try to find by their OIDC identifier or email
        user = await prisma.user.findFirst({
          where: {
            OR: [
              { uuid: authenticatedUser.identifier },
              { email: authenticatedUser.email || undefined },
            ],
          },
        });
      }
      
      // If not found and we have a userIdentifier, try that (for guest conversion)
      if (!user) {
        user = await prisma.user.findFirst({
          where: {
            OR: [
              { uuid: userIdentifier },
              { email: userIdentifier.includes('@') ? userIdentifier : undefined },
            ],
          },
        });
      }
      
      // Determine name: authenticated user name > query param name > existing name
      const userName = authenticatedUser?.name || name || null;
      // Determine email: authenticated user email > email from identifier > existing email
      const userEmail = authenticatedUser?.email || (userIdentifier.includes('@') ? userIdentifier : null);
      
      // Determine final UUID: authenticated identifier > userIdentifier
      const finalUuid = authenticatedUser?.identifier || userIdentifier;
      
      if (!user) {
        // Create user if doesn't exist
        user = await prisma.user.create({
          data: {
            uuid: finalUuid,
            email: userEmail,
            name: userName,
            matrixChatId: chatID || null,
            lastIpAddress: ipAddress || null,
            isGuest: isGuest,
          },
        });
      } else {
        // Update existing user with new information if available
        const updateData: {
          email?: string | null;
          name?: string | null;
          matrixChatId?: string | null;
          lastIpAddress?: string | null;
          isGuest?: boolean;
          uuid?: string;
        } = {};
        
        // Always update isGuest status to reflect current authentication state
        // This ensures the field is always accurate
        if (user.isGuest !== isGuest) {
          updateData.isGuest = isGuest;
        }
        
        // If converting from guest to authenticated, update UUID if needed
        if (user.isGuest && authenticatedUser?.isAuthenticated && authenticatedUser.identifier && authenticatedUser.identifier !== user.uuid) {
          updateData.uuid = authenticatedUser.identifier;
        }
        
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
      
      // Get or create world membership (only for authenticated users)
      let membership = await prisma.worldMember.findUnique({
        where: {
          userId_worldId: {
            userId: user.id,
            worldId: worldData.id,
          },
        },
      });
      
      // Only create world membership for authenticated users
      // Guest users can access rooms but don't get world memberships
      if (!membership && authenticatedUser?.isAuthenticated) {
        // Create membership with tags from authenticated user
        membership = await prisma.worldMember.create({
          data: {
            userId: user.id,
            worldId: worldData.id,
            tags: authenticatedUser?.tags || [],
          },
        });
      }
      
      // For guests, create a temporary membership object for the response
      // but don't store it in the database
      if (!membership && isGuest) {
        membership = {
          id: '',
          userId: user.id,
          worldId: worldData.id,
          tags: [],
          joinedAt: new Date(),
        } as any;
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
      
      // Send Discord webhook notification (non-blocking)
      notifyRoomAccess({
        userName: user.name,
        userEmail: user.email,
        userUuid: user.uuid,
        isGuest: user.isGuest,
        tags: membership?.tags || [],
        playUri: playUri,
        universe: universe,
        world: world,
        room: room,
        ipAddress: ipAddress,
      }).catch((error) => {
        // Log but don't fail the request if webhook fails
        console.error('Failed to send Discord webhook:', error);
      });
      
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

