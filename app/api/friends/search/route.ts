import { NextRequest } from 'next/server';
import { requireAccount, searchPeople } from '@/lib/friends';
import { friendsRoute } from '@/lib/friends-http';

// GET /api/friends/search?userUuid=&q= - players who chose to be findable by name
export const GET = friendsRoute('/api/friends/search', async (request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const me = await requireAccount(params.get('userUuid'));
  return { results: await searchPeople(me, params.get('q') ?? '') };
});
