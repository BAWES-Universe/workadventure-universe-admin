import { NextRequest } from 'next/server';
import { listFriends, requireAccount } from '@/lib/friends';
import { friendsRoute } from '@/lib/friends-http';

// GET /api/friends?userUuid= - the player's friends, open requests both ways, and who they blocked
export const GET = friendsRoute('/api/friends', async (request: NextRequest) => {
  const me = await requireAccount(request.nextUrl.searchParams.get('userUuid'));
  return listFriends(me);
});
