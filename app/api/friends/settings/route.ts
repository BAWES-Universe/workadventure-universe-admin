import { NextRequest } from 'next/server';
import { FriendsError, loadPeopleSettings, requireAccount, savePeopleSettings } from '@/lib/friends';
import { friendsRoute, readJsonObject, stringField } from '@/lib/friends-http';
import { PEOPLE_PREFERENCE_KEYS, isValidPeopleSetting, type PeopleSettings } from '@/lib/people-settings';

// GET /api/friends/settings?userUuid= - who can ring and friend the player, and what friends see
export const GET = friendsRoute('/api/friends/settings', async (request: NextRequest) => {
  const me = await requireAccount(request.nextUrl.searchParams.get('userUuid'));
  return { settings: await loadPeopleSettings(me.id) };
});

// PUT /api/friends/settings { userUuid, settings: { ringFrom?, friendRequestsFrom?, findableByName?, friendsSeeLocation? } }
export const PUT = friendsRoute('/api/friends/settings', async (request: NextRequest) => {
  const body = await readJsonObject(request);
  const me = await requireAccount(stringField(body.userUuid));
  const settings = body.settings;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new FriendsError('settings must be an object', 400);
  }
  const changes: Partial<PeopleSettings> = {};
  for (const [field, value] of Object.entries(settings)) {
    if (!Object.prototype.hasOwnProperty.call(PEOPLE_PREFERENCE_KEYS, field)) throw new FriendsError(`unknown_setting:${field}`, 400);
    const key = PEOPLE_PREFERENCE_KEYS[field as keyof PeopleSettings];
    if (!isValidPeopleSetting(key, value)) throw new FriendsError(`invalid_value:${field}`, 400);
    (changes as Record<string, unknown>)[field] = value;
  }
  return { settings: await savePeopleSettings(me.id, changes) };
});
