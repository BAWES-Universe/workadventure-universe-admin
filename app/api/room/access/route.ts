import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireAuth, getClientIp } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { authenticateRequest } from '@/lib/oidc';
import { prisma } from '@/lib/db';
import { resolveTextureUrls, resolveCompanionTexture } from '@/lib/avatar-catalog-validator';
import { notifyRoomAccess } from '@/lib/discord';
import { isBotIdentifier } from '@/lib/bot-visitor';
import { currentOutfit, recordOutfitPick } from '@/lib/user-outfits';
import { companionWearableHere, wearableHere } from '@/lib/woka-wearable';
import { canSeeRoom } from '@/lib/room-visibility';
import { isSuperAdmin } from '@/lib/super-admin';
import { bansCoveringWorld } from '@/lib/moderation';
import type { FetchMemberDataByUuidSuccessResponse, ErrorApiData, ErrorApiRetryData, CompanionDetail } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const userIdentifier = searchParams.get('userIdentifier');
    const playUri = searchParams.get('playUri');
    const ipAddress = searchParams.get('ipAddress') || getClientIp(request);
    const accessToken = searchParams.get('accessToken');
    // The game only sends a chat ID it checked itself (today: a bot's own account). It is passed back for this
    // visit but never saved here: a person's chat ID is saved only through /api/members/:id/chatId, once the game
    // has confirmed it with the Matrix server.
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
      const hasAccessToken = !!accessToken;
      const isAuthenticatedFromToken = authenticatedUser?.isAuthenticated === true;
      const isGuest = !hasAccessToken || !isAuthenticatedFromToken;
      const isAuthenticated = !isGuest;
      
      // Determine user data from request (will be updated from user record if authenticated)
      let userName = authenticatedUser?.name || name || null;
      let userEmail = authenticatedUser?.email || (userIdentifier.includes('@') ? userIdentifier : null);
      const finalUuid = authenticatedUser?.identifier || userIdentifier;
      
      // Only create/find User records for authenticated users
      // But also try to find existing user by identifier even if not authenticated in this request
      let user: { id: string; name: string | null; email: string | null; uuid: string; matrixChatId: string | null; isGuest: boolean; companionTextureId: string | null } | null = null;
      let membership = null;
      let avatar = null;
      
      // Try to find user by identifier (either from authenticated user or userIdentifier)
      const lookupIdentifier = authenticatedUser?.identifier || userIdentifier;
      if (lookupIdentifier) {
        user = await prisma.user.findFirst({
          where: {
            OR: [
              { uuid: lookupIdentifier },
              { email: lookupIdentifier.includes('@') ? lookupIdentifier : undefined },
            ],
          },
        });
      }
      
      // If user is authenticated (has valid accessToken), create/update user record
      if (isAuthenticated && authenticatedUser?.identifier) {
        // User already found above, but if not found, create new one
        if (!user) {
          // Create new authenticated user
          user = await prisma.user.create({
            data: {
              uuid: authenticatedUser.identifier,
              email: userEmail,
              name: userName,
              lastIpAddress: ipAddress || null,
              isGuest: false,
            } as any,
          });
          // Update userName and userEmail from created user record (prefer user record)
          if (user) {
            userName = user.name || userName;
            userEmail = user.email || userEmail;
          }
        } else {
          // Update existing user
          const updateData: {
            email?: string | null;
            name?: string | null;
            lastIpAddress?: string | null;
            isGuest?: boolean;
            uuid?: string;
          } = {};
          
          if (user.isGuest) {
            updateData.isGuest = false; // User is now authenticated
          }
          
          if (userEmail && !user.email) {
            updateData.email = userEmail;
          }
          
          // The name picked in the game is the person's name everywhere: the sign-in name is only used when they
          // have none yet (it never replaces one on a later room entry).
          if (userName && !user.name) {
            updateData.name = userName;
          }
          
          if (ipAddress) {
            updateData.lastIpAddress = ipAddress;
          }
          
          if (Object.keys(updateData).length > 0) {
            user = await prisma.user.update({
              where: { id: user.id },
              data: updateData,
            });
          }
          // Update userName and userEmail from user record (prefer user record)
          if (user) {
            userName = user.name || userName;
            userEmail = user.email || userEmail;
          }
        }
      } else if (user) {
        // User exists but not authenticated in this request - update name/email from user record
        userName = user.name || userName;
        userEmail = user.email || userEmail;
      }
      
      // An account that joins without a token we could check (expired, Authentik unreachable, none sent) is answered as a
      // guest: we can't tell it is them. It never gets a Woka saved for some world, which may be an old pick (that is how
      // a default or an old Woka was worn silently); only what the game sent counts, and when that is nothing this world
      // can show, the answer is "not valid" so the game asks. Say so, so it can be seen when a player gets this.
      const unverifiedAccount = !!user && !user.isGuest && !isAuthenticated && !isBotIdentifier(finalUuid);
      if (unverifiedAccount && hasAccessToken) {
        Sentry.captureMessage('Room access: an account joined with an access token Orbit could not verify, so it was answered as a guest', 'warning');
      }

      // Find world and room
      const worldData = await prisma.world.findFirst({
        where: {
          slug: world,
          universe: {
            slug: universe,
          },
        },
        include: {
          universe: {
            select: {
              id: true,
              slug: true,
              isPublic: true,
              ownerId: true,
            },
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
      
      const roomData = await prisma.room.findFirst({
        where: {
          slug: room,
          worldId: worldData.id,
        },
      });
      
      if (!roomData) {
        const error: ErrorApiData = {
          status: "error",
          type: "error",
          title: "Room not found",
          subtitle: "The requested room does not exist",
          code: "ROOM_NOT_FOUND",
          details: `The room ${universe}/${world}/${room} could not be found.`,
        };
        return NextResponse.json(error, { status: 404 });
      }
      
      // Check if user is banned (by userId if authenticated, or by IP)
      const ban = await prisma.ban.findFirst({
        where: {
          AND: [
            bansCoveringWorld(worldData),
            { OR: [...(user ? [{ userId: user.id }] : []), { ipAddress: ipAddress }] },
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
      
      // Get world membership (for any user with User record, not just authenticated)
      if (user) {
        membership = await prisma.worldMember.findUnique({
          where: {
            userId_worldId: {
              userId: user.id,
              worldId: worldData.id,
            },
          },
        });
      }

      // Members-only rooms: a room is open to everyone only when it, its world and its universe are all public.
      // Otherwise only the universe owner, the world's members, super admins and the room's own bots get in.
      // Who somebody is counts only once they have signed in: the identifier in the address is whatever the caller
      // sent, and a member's id is not a secret.
      const canEnter =
        canSeeRoom(
          { isPublic: roomData.isPublic, world: worldData },
          isAuthenticated && user ? { id: user.id, isSuperAdmin: isSuperAdmin(user.email) } : null,
          new Set(isAuthenticated && membership ? [worldData.id] : []),
        ) ||
        (isBotIdentifier(finalUuid) &&
          !!(await prisma.bot.findFirst({
            where: { id: finalUuid.slice('bot-'.length), roomId: roomData.id },
            select: { id: true },
          })));
      if (!canEnter) {
        // Answered with 200 so the game shows this screen (it only reads error bodies on success)
        const error: ErrorApiData = {
          status: "error",
          type: "error",
          title: "Members only",
          subtitle: "This place is only open to its members",
          code: "MEMBERS_ONLY",
          details: "Ask one of its admins to invite you, then come back.",
        };
        return NextResponse.json(error);
      }

      if (user && !unverifiedAccount) {
        
        // Get user avatar
        avatar = await prisma.userAvatar.findUnique({
          where: {
            userId_worldId: {
              userId: user.id,
              worldId: worldData.id,
            },
          },
        });
      }
      
      // Get visit card to determine visitCardUrl
      let visitCardUrl: string | null = null;
      if (user) {
        try {
          const visitCard = await (prisma as any).visitCard.findUnique({
            where: { userId: user.id },
          });
          
          if (visitCard) {
            // Use NEXT_PUBLIC_API_URL (admin URL) as base URL for visit card links
            const baseUrl = process.env.NEXT_PUBLIC_API_URL || process.env.NEXT_PUBLIC_BASE_URL || process.env.BASE_URL || '';
            if (baseUrl) {
              // Encode UUID to handle special characters like @
              const encodedUuid = encodeURIComponent(user.uuid);
              visitCardUrl = `${baseUrl}/api/profile/${encodedUuid}?embed=true`;
            } else {
              console.warn('[VisitCard] No base URL configured - cannot generate visitCardUrl');
            }
          }
        } catch (error) {
          console.error('[VisitCard] Error fetching visit card:', error);
          // Don't fail the request if visit card lookup fails
        }
      }
      
      // Create temporary membership object for response (if no real membership)
      if (!membership) {
        membership = {
          id: '',
          userId: user?.id || '',
          worldId: worldData.id,
          tags: [], // Empty tags for all non-members (guests)
          joinedAt: new Date(),
        } as any;
      }
      
      // Get play service URL for texture validation
      const playServiceUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost';
      
      // Validate character textures — first try catalog, fall back to static JSON
      const textureValidation = await resolveTextureUrls(
        prisma, textureIds, worldData.id, worldData.universeId, playServiceUrl
      );
      
      // Validate companion texture if provided
      const companionValidation = await resolveCompanionTexture(
        prisma, companionTextureId, worldData.id, worldData.universeId, playServiceUrl
      );
      
      // If textures are invalid and we have stored avatar textures, use them as fallback
      let finalTextures = textureValidation.textures;
      let isTexturesValid = textureValidation.valid;
      
      // Prefer DB textures over localStorage when user has a saved avatar —
      // DB is the source of truth across devices and sessions
      if (avatar?.textureIds && avatar.textureIds.length > 0) {
        const dbTextures = await resolveTextureUrls(
          prisma, avatar.textureIds, worldData.id, worldData.universeId, playServiceUrl
        );
        if (dbTextures.valid) {
          finalTextures = dbTextures.textures;
          isTexturesValid = true;
        }
      }

      // Your Woka stays yours: a signed-in person wears one Woka in every world, the last one they picked themselves.
      // Entering a world never changes it. If this world can't show it (a costume from elsewhere, a set that was
      // removed or ended, access lost), the answer is "not valid" and the game asks them what to wear; nothing is saved.
      // The one write: someone who never picked has no Woka yet, so the outfit the game sent is worn if this world allows
      // it, and recorded as their first pick. The textures the game sent otherwise never count: they may be stale.
      // Guests and bots keep the logic above as it was.
      let ownCompanion: { texture: CompanionDetail | null; valid: boolean } | null = null;
      // The Woka their account says they wear, even when this world can't show it (see characterTextureIds below)
      let accountTextureIds: string[] | null = null;
      if (user && isAuthenticated && !isBotIdentifier(finalUuid)) {
        try {
          const wearing = {
            worldId: worldData.id,
            universeId: worldData.universeId,
            userId: user.id,
            membershipTags: (membership && 'tags' in membership && Array.isArray(membership.tags)) ? membership.tags : [],
          };
          const current = await currentOutfit(user.id);
          let wear: string[] | null = null;
          let firstPick = false;
          if (current) {
            wear = (await wearableHere(current.textureIds, wearing)).wearable ? current.textureIds : null;
          } else if (textureIds.length > 0 && (await wearableHere(textureIds, wearing)).wearable) {
            wear = textureIds;
            firstPick = true;
          }
          const worn = wear
            ? await resolveTextureUrls(prisma, wear, worldData.id, worldData.universeId, playServiceUrl)
            : { valid: false, textures: [] };
          // Their companion is just as much theirs: the one they wear now (none is fine), if this world can show it.
          let companion: { texture: CompanionDetail | null; valid: boolean } = { texture: null, valid: true };
          let firstCompanion: string | null = null;
          if (user.companionTextureId) {
            const allowed = (await companionWearableHere(user.companionTextureId, wearing)).wearable;
            const resolved = allowed
              ? await resolveCompanionTexture(prisma, user.companionTextureId, worldData.id, worldData.universeId, playServiceUrl)
              : { valid: false, texture: null };
            companion = { texture: resolved.texture, valid: resolved.valid };
          } else if (firstPick && companionTextureId && (await companionWearableHere(companionTextureId, wearing)).wearable) {
            // First entry (a guest who just signed up): the companion the game sent is worn and kept, like the Woka
            const resolved = await resolveCompanionTexture(prisma, companionTextureId, worldData.id, worldData.universeId, playServiceUrl);
            if (resolved.valid && resolved.texture) {
              companion = { texture: resolved.texture, valid: true };
              firstCompanion = companionTextureId;
            }
          }
          if (firstPick && worn.valid) {
            await recordOutfitPick(user.id, wear as string[]);
            // Only while they still have none, so a companion picked in the meantime is never overwritten
            if (firstCompanion) await prisma.user.updateMany({ where: { id: user.id, companionTextureId: null }, data: { companionTextureId: firstCompanion } });
          }
          finalTextures = worn.valid ? worn.textures : [];
          isTexturesValid = worn.valid;
          accountTextureIds = current?.textureIds ?? (firstPick && worn.valid ? wear : null);
          ownCompanion = companion;
        } catch (error) {
          // A signed-in person is never handed a Woka or companion that did not pass the checks above: the Woka saved
          // for this world, or the one the game sent, was only checked against the catalog, not who may wear it, and
          // the game keeps whatever comes back as their Woka on the device. So the game shows its retry screen
          // instead, and nothing is saved or sent. Answered with 200 so the game shows it (it only reads error bodies
          // on success). Guests and bots do not come through here.
          console.error('Failed to look up the Woka they wear:', error);
          Sentry.captureException(error);
          const retry: ErrorApiRetryData = {
            status: "error",
            type: "retry",
            title: "Couldn't load your Woka",
            subtitle: "We couldn't load your Woka. Trying again.",
            code: "WOKA_LOOKUP_FAILED",
            details: "This usually clears up in a few seconds.",
            buttonTitle: "Retry",
            timeToRetry: 5000,
            canRetryManual: true,
          };
          return NextResponse.json(retry);
        }
      }

      // Extract texture IDs for front-end cross-device sync. A signed-in person's are the Woka their account says they
      // wear, also when this world can't show it: the game keeps them on the device, and the picker and popup name them.
      const characterTextureIds = accountTextureIds ?? finalTextures.map(t => t.id);
      
      // Handle companion texture - use stored one if provided one is invalid
      let finalCompanionTexture = companionValidation.texture;
      let isCompanionValid = companionValidation.valid;
      
      if (ownCompanion) {
        // Signed-in people wear the companion saved on their account, whatever the game sent
        finalCompanionTexture = ownCompanion.texture;
        isCompanionValid = ownCompanion.valid;
      } else if ((!isCompanionValid || !companionTextureId) && avatar?.companionTextureId) {
        const fallbackCompanion = await resolveCompanionTexture(
          prisma, avatar.companionTextureId, worldData.id, worldData.universeId, playServiceUrl
        );
        if (fallbackCompanion.valid) {
          finalCompanionTexture = fallbackCompanion.texture;
          isCompanionValid = true;
        }
      }
      
      // Log room access to analytics (for all users, authenticated and unauthenticated)
      // Extract membership tags - ensure we get them from the membership object
      const membershipTags = (membership && 'tags' in membership && Array.isArray(membership.tags)) 
        ? membership.tags 
        : [];
      
      // Determine actual guest status for analytics: user is guest if they don't have a User record OR if they have one but isGuest is true
      // But if user has membership tags, they're not really a guest
      const actualIsGuestForAnalytics = !user || (user.isGuest && membershipTags.length === 0);
      
      // Bots join rooms through this same check. Their joins are reconnects, not visits, so they aren't recorded.
      // (The Discord notification below still goes out as before.)
      if (!isBotIdentifier(finalUuid)) {
        await (prisma as any).roomAccess.create({
          data: {
            userUuid: finalUuid,
            userId: user?.id || null,
            ipAddress: ipAddress,
            userName: user ? (user.name || userName) : userName,
            userEmail: user ? (user.email || userEmail) : userEmail,
            isGuest: actualIsGuestForAnalytics,
            isAuthenticated: isAuthenticated,
            hasMembership: membershipTags.length > 0,
            membershipTags: membershipTags,
            universeId: worldData.universeId,
            worldId: worldData.id,
            roomId: roomData.id,
            universeSlug: universe,
            worldSlug: world,
            roomSlug: room,
            playUri: playUri,
            // A guest has no saved outfit, so the one they picked is kept with the visit; a person's account has theirs.
            textureIds: actualIsGuestForAnalytics && isTexturesValid ? characterTextureIds : [],
          },
        }).catch((error: unknown) => {
          // Log but don't fail the request if analytics logging fails
          console.error('Failed to log room access analytics:', error);
        });
      }
      
      // Build response
      const response: FetchMemberDataByUuidSuccessResponse = {
        status: "ok",
        email: user?.email || null,
        username: user?.name || userName || undefined,
        userUuid: finalUuid,
        tags: membershipTags,
        visitCardUrl: visitCardUrl,
        isCharacterTexturesValid: isTexturesValid,
        characterTextures: finalTextures,
        characterTextureIds: characterTextureIds,
        isCompanionTextureValid: isCompanionValid,
        companionTexture: finalCompanionTexture,
        messages: [],
        userRoomToken: "",
        activatedInviteUser: true,
        applications: [],
        canEdit: membershipTags.includes('editor') || membershipTags.includes('admin'),
        world: world,
        chatID: chatID || user?.matrixChatId || undefined,
      };
      
      // Send Discord webhook notification (non-blocking)
      // Ensure we use the user record's name/email if available (prefer user record over request params)
      // Always prefer user record values if user exists
      const webhookUserName = user ? (user.name || userName) : userName;
      const webhookUserEmail = user ? (user.email || userEmail) : userEmail;
      
      // Determine actual guest status for webhook: 
      // - If user has membership tags, they're not a guest
      // - If user exists and isGuest is false, they're not a guest
      // - Otherwise, they're a guest
      const webhookIsGuest = !user || (user.isGuest && membershipTags.length === 0);
      
      // Ensure membership tags are passed correctly
      const webhookTags = membershipTags;
      
      notifyRoomAccess({
        userName: webhookUserName,
        userEmail: webhookUserEmail,
        userUuid: finalUuid,
        isGuest: webhookIsGuest,
        tags: webhookTags,
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

