import { z } from 'zod';
import { canManageWorldMembers, isPrivileged, viewerUserId, type Viewer } from '@/lib/access-scope';
import { ORBIT_HOME_PATH, isKnownIntent } from '@/lib/orbit-bridge';

const worldMembersParams = z.object({ worldId: z.string().uuid() });

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
    case 'world-members': {
      const parsed = worldMembersParams.safeParse(params ?? {});
      if (!parsed.success) return ORBIT_HOME_PATH;
      const { worldId } = parsed.data;
      const userId = viewerUserId(viewer);
      const allowed = isPrivileged(viewer) || (userId !== null && (await canManageWorldMembers(userId, worldId)));
      return allowed ? `/admin/worlds/${worldId}?tab=members` : ORBIT_HOME_PATH;
    }
  }
}
