import { NextRequest } from 'next/server';
import { FRIEND_ACTIONS, FriendsError, applyFriendAction, findAccount, requireAccount, type FriendAction } from '@/lib/friends';
import { friendsRoute, readJsonObject, stringField } from '@/lib/friends-http';

// POST /api/friends/action { userUuid, targetUuid, action } - request, accept, ignore, cancel, remove, block, unblock
export const POST = friendsRoute('/api/friends/action', async (request: NextRequest) => {
  const body = await readJsonObject(request);
  const action = body.action;
  if (typeof action !== 'string' || !FRIEND_ACTIONS.includes(action as FriendAction)) {
    throw new FriendsError('unknown_action', 400);
  }
  const me = await requireAccount(stringField(body.userUuid));
  const targetUuid = stringField(body.targetUuid);
  if (!targetUuid) throw new FriendsError('targetUuid is required', 400);
  const target = await findAccount(targetUuid);
  if (!target) throw new FriendsError('player_not_found', 404);
  return { relationship: await applyFriendAction(me, target, action as FriendAction) };
});
