import type { NextRequest } from 'next/server';
import { memberWorldIdsOf, type Viewer } from '@/lib/access-scope';
import type { SessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { canSeeWorld } from '@/lib/room-visibility';
import { parsePlayUri } from '@/lib/utils';

/**
 * Orbit opened in the game says which room the player is in (the game puts it on Orbit's address, and Orbit keeps it
 * for the visit and sends it with every request in this header). Outside the game there is none.
 */
export const ORBIT_PLAY_URI_HEADER = 'x-orbit-play-uri';

/** The longest room address Orbit keeps or reads. */
export const ORBIT_PLAY_URI_MAX_LENGTH = 2048;

/**
 * The world the viewer is looking from, to pick the Woka to draw for people (see `wokaOutfitsFor`): the world of the
 * room the game says they are in. It only changes which picture is drawn, so nothing it names is trusted beyond that;
 * a world the viewer could not see anyway (a private one they are not in) counts as no world, so the header can't be
 * used to look at what a world keeps to itself. Undefined outside the game, for a room that isn't a world's, or on any error.
 */
export async function viewerWorldId(
  request: NextRequest,
  who: Viewer | Pick<SessionUser, 'id' | 'isSuperAdmin'> | null,
): Promise<string | undefined> {
  // Only a signed-in person looks from a world (a caller with the admin token does not).
  const user = who && 'kind' in who ? (who.kind === 'user' ? who.user : null) : who;
  if (!user) return undefined;
  const playUri = request.headers.get(ORBIT_PLAY_URI_HEADER);
  if (!playUri || playUri.length > ORBIT_PLAY_URI_MAX_LENGTH) return undefined;
  try {
    const { universe, world } = parsePlayUri(playUri);
    const found = await prisma.world.findFirst({
      where: { slug: world, universe: { slug: universe } },
      select: { id: true, isPublic: true, universe: { select: { isPublic: true, ownerId: true } } },
    });
    if (!found) return undefined;
    const memberWorldIds = await memberWorldIdsOf(user.id, [found.id]);
    return canSeeWorld(found, user, memberWorldIds) ? found.id : undefined;
  } catch {
    return undefined;
  }
}
