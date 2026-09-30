import { z } from 'zod';
import { canManageWorldMembers, isPrivileged, viewerUserId, type Viewer } from '@/lib/access-scope';
import { prisma } from '@/lib/db';
import { ORBIT_HOME_PATH, isKnownIntent } from '@/lib/orbit-bridge';

const worldMembersParams = z.object({ worldId: z.string().uuid() });
// The game's id for a player (the user's uuid, which can be an email address).
const userProfileParams = z.object({ userUuid: z.string().min(1).max(256) });

/**
 * The Orbit page for a page request from the game, decided by Orbit alone: the game only names an intent, and
 * Orbit checks the viewer may see that page. An unknown intent, bad parameters or a page the viewer may not see all
 * land on Orbit's home, with no error.
 */
export async function resolveNavigateIntent(
  viewer: Viewer,
  intent: string,
  params: Record<string, string> | undefined,
): Promise<string> {
  if (!isKnownIntent(intent)) return ORBIT_HOME_PATH;

  switch (intent) {
    case 'new-universe':
      // Every signed-in user may create a universe (they become its owner).
      return '/admin/universes/new';
    case 'visit-card':
      // Everyone edits their own profile (once the visit card), in place on You.
      return '/admin/you?edit=profile';
    case 'world-members': {
      const parsed = worldMembersParams.safeParse(params ?? {});
      if (!parsed.success) return ORBIT_HOME_PATH;
      const { worldId } = parsed.data;
      const userId = viewerUserId(viewer);
      const allowed = isPrivileged(viewer) || (userId !== null && (await canManageWorldMembers(userId, worldId)));
      return allowed ? `/admin/worlds/${worldId}?tab=members` : ORBIT_HOME_PATH;
    }
    case 'user-profile': {
      // Someone's profile, from their card in the game: yours is You, anyone else's is their page, which shows
      // every signed-in viewer only the public part. Guests and unknown players have no profile.
      const parsed = userProfileParams.safeParse(params ?? {});
      if (!parsed.success) return ORBIT_HOME_PATH;
      const user = await prisma.user.findUnique({
        where: { uuid: parsed.data.userUuid },
        select: { id: true, isGuest: true },
      });
      if (!user || user.isGuest) return ORBIT_HOME_PATH;
      return user.id === viewerUserId(viewer) ? '/admin/you' : `/admin/users/${user.id}`;
    }
  }
}
