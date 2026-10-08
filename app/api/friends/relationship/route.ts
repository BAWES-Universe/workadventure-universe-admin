import { NextRequest } from 'next/server';
import { FriendsError, findAccount, loadPeopleSettings, relationshipBetween, requireAccount, sharesMemberWorld } from '@/lib/friends';
import { friendsRoute } from '@/lib/friends-http';

// GET /api/friends/relationship?userUuid=&targetUuid= - how the pair stands, whether they are members of a world together, and the target's invite and location settings
export const GET = friendsRoute('/api/friends/relationship', async (request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const me = await requireAccount(params.get('userUuid'));
  const targetUuid = params.get('targetUuid');
  if (!targetUuid) throw new FriendsError('targetUuid is required', 400);
  const target = await findAccount(targetUuid);
  if (!target) throw new FriendsError('player_not_found', 404);
  const settings = await loadPeopleSettings(target.id);
  return {
    relationship: await relationshipBetween(me, target),
    sharedWorld: await sharesMemberWorld(me.id, target.id),
    target: { ringFrom: settings.ringFrom, friendsSeeLocation: settings.friendsSeeLocation },
  };
});
