import { NextRequest } from 'next/server';
import { FriendsError, MAX_PLACES, placeNames } from '@/lib/friends';
import { friendsRoute, readJsonObject } from '@/lib/friends-http';

// POST /api/friends/places { playUris } - universe, world and room names for the rooms friends are in
export const POST = friendsRoute('/api/friends/places', async (request: NextRequest) => {
  const body = await readJsonObject(request);
  const playUris = body.playUris;
  if (!Array.isArray(playUris) || playUris.length > MAX_PLACES || !playUris.every((uri) => typeof uri === 'string')) {
    throw new FriendsError(`playUris must be at most ${MAX_PLACES} strings`, 400);
  }
  return { places: await placeNames(playUris as string[]) };
});
