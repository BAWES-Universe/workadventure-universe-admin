import { NextRequest } from 'next/server';
import { GET as list } from '@/app/api/friends/route';
import { POST as act } from '@/app/api/friends/action/route';
import { GET as search } from '@/app/api/friends/search/route';
import { GET as getSettings, PUT as putSettings } from '@/app/api/friends/settings/route';
import { GET as relationship } from '@/app/api/friends/relationship/route';
import { POST as places } from '@/app/api/friends/places/route';
import { MAX_OPEN_REQUESTS } from '@/lib/friends';
import { addUser, db } from '../../helpers/friends-db';

jest.mock('@/lib/db', () => ({ prisma: jest.requireActual('../../helpers/friends-db').fakePrisma }));

const BASE = 'http://localhost:3333/api/friends';
const TOKEN = 'test-admin-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

function get(handler: (r: NextRequest) => Promise<Response>, path: string, query: Record<string, string>, headers = auth) {
  return handler(new NextRequest(`${BASE}${path}?${new URLSearchParams(query)}`, { headers }));
}

function send(handler: (r: NextRequest) => Promise<Response>, path: string, method: string, body: unknown, headers = auth) {
  return handler(new NextRequest(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

async function action(from: string, to: string, kind: string) {
  const res = await send(act, '/action', 'POST', { userUuid: `uuid-${from}`, targetUuid: `uuid-${to}`, action: kind });
  return { status: res.status, body: await res.json() };
}

async function friendsOf(id: string) {
  const res = await get(list, '', { userUuid: `uuid-${id}` });
  expect(res.status).toBe(200);
  return res.json();
}

/** Both are members of the same world, which is what the "Shared worlds" request setting needs. */
function shareWorld(...ids: string[]) {
  for (const id of ids) db.members.push({ userId: id, worldId: 'w1', worldName: 'Main Hall', universeName: 'Bawes' });
}

describe('/api/friends', () => {
  const env = process.env.ADMIN_API_TOKEN;
  beforeAll(() => { process.env.ADMIN_API_TOKEN = TOKEN; });
  afterAll(() => { process.env.ADMIN_API_TOKEN = env; });

  beforeEach(() => {
    db.reset();
    jest.clearAllMocks();
    addUser('a', 'Alice');
    addUser('b', 'Bilal');
    addUser('c', 'Carla');
    addUser('g', 'Guest', { isGuest: true });
  });

  it('refuses calls without the service token', async () => {
    expect((await get(list, '', { userUuid: 'uuid-a' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await send(act, '/action', 'POST', { userUuid: 'uuid-a', targetUuid: 'uuid-b', action: 'request' }, {} as typeof auth)).status).toBe(401);
    expect(db.friendships).toHaveLength(0);
  });

  it('is for signed-in players only, on both sides', async () => {
    expect((await action('g', 'a', 'request')).body).toEqual({ error: 'sign_in_required' });
    expect(await action('a', 'g', 'request')).toEqual({ status: 404, body: { error: 'player_not_found' } });
    expect((await get(list, '', { userUuid: 'uuid-missing' })).status).toBe(403);
    expect((await get(list, '', {})).status).toBe(400);
  });

  it('rejects unknown actions and yourself', async () => {
    expect((await action('a', 'b', 'poke')).status).toBe(400);
    expect(await action('a', 'a', 'request')).toEqual({ status: 400, body: { error: 'cannot_friend_yourself' } });
  });

  it('request then accept makes friends, listed alphabetically on both sides', async () => {
    shareWorld('a', 'b', 'c');
    expect((await action('a', 'b', 'request')).body).toEqual({ relationship: 'request_sent' });
    expect((await action('a', 'b', 'request')).body).toEqual({ relationship: 'request_sent' });
    expect(db.friendships).toHaveLength(1);

    const bilal = await friendsOf('b');
    expect(bilal.incoming).toEqual([expect.objectContaining({ uuid: 'uuid-a', name: 'Alice', sharedWorld: 'Main Hall' })]);
    expect((await friendsOf('a')).outgoing).toEqual([expect.objectContaining({ uuid: 'uuid-b' })]);

    expect((await action('b', 'a', 'accept')).body).toEqual({ relationship: 'friends' });
    await action('c', 'a', 'request');
    await action('a', 'c', 'accept');

    const alice = await friendsOf('a');
    expect(alice.friends.map((f: { name: string }) => f.name)).toEqual(['Bilal', 'Carla']);
    expect(alice.friends[0]).toEqual(expect.objectContaining({ chatId: '@b:chat', shareLocation: true }));
    expect(alice.incoming).toEqual([]);
    expect(alice.outgoing).toEqual([]);
  });

  it('a request back to someone who asked you accepts theirs', async () => {
    shareWorld('a', 'b');
    await action('a', 'b', 'request');
    expect((await action('b', 'a', 'request')).body).toEqual({ relationship: 'friends' });
    expect(db.friendships).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  it('"Not now" hides the request from the receiver while the sender still sees it waiting', async () => {
    shareWorld('a', 'b');
    await action('a', 'b', 'request');
    expect((await action('b', 'a', 'ignore')).body).toEqual({ relationship: 'request_received' });
    expect((await friendsOf('b')).incoming).toEqual([]);
    expect((await friendsOf('a')).outgoing).toHaveLength(1);
    expect((await action('a', 'b', 'request')).body).toEqual({ relationship: 'request_sent' });
    expect(db.friendships[0].status).toBe('ignored');
    // The receiver can still change their mind.
    expect((await action('b', 'a', 'accept')).body).toEqual({ relationship: 'friends' });
  });

  it('accept or ignore without a request is a conflict', async () => {
    expect((await action('a', 'b', 'accept')).status).toBe(409);
    expect((await action('a', 'b', 'ignore')).status).toBe(409);
    shareWorld('a', 'b');
    await action('a', 'b', 'request');
    // Only the receiver can accept.
    expect((await action('a', 'b', 'accept')).status).toBe(409);
  });

  it('cancel and remove delete the pair; both are safe to repeat', async () => {
    shareWorld('a', 'b');
    await action('a', 'b', 'request');
    expect((await action('a', 'b', 'cancel')).body).toEqual({ relationship: 'none' });
    expect((await action('a', 'b', 'cancel')).body).toEqual({ relationship: 'none' });
    expect(db.friendships).toHaveLength(0);

    await action('a', 'b', 'request');
    await action('b', 'a', 'accept');
    expect((await action('b', 'a', 'remove')).body).toEqual({ relationship: 'none' });
    expect((await action('b', 'a', 'remove')).body).toEqual({ relationship: 'none' });
    expect(db.friendships).toHaveLength(0);
  });

  it('block ends a friendship, stops requests both ways, and only the blocker can undo it', async () => {
    shareWorld('a', 'b');
    await action('a', 'b', 'request');
    await action('b', 'a', 'accept');
    expect((await action('a', 'b', 'block')).body).toEqual({ relationship: 'blocked_by_me' });
    expect(db.friendships).toEqual([expect.objectContaining({ status: 'blocked', requestedById: 'a', acceptedAt: null })]);

    expect(await action('b', 'a', 'request')).toEqual({ status: 403, body: { error: 'blocked' } });
    expect(await action('a', 'b', 'request')).toEqual({ status: 403, body: { error: 'blocked' } });
    expect((await action('b', 'a', 'unblock')).body).toEqual({ relationship: 'blocked_by_them' });
    expect((await action('b', 'a', 'block')).body).toEqual({ relationship: 'blocked_by_them' });
    expect(db.friendships[0].requestedById).toBe('a');

    expect((await friendsOf('a')).blocked).toEqual([{ uuid: 'uuid-b', name: 'Bilal' }]);
    expect((await friendsOf('b')).friends).toEqual([]);
    expect((await friendsOf('b')).blocked).toEqual([]);

    expect((await action('a', 'b', 'unblock')).body).toEqual({ relationship: 'none' });
    expect(db.friendships).toHaveLength(0);
  });

  it('by default anyone signed in can send a request', async () => {
    expect((await action('a', 'b', 'request')).body).toEqual({ relationship: 'request_sent' });
    expect((await friendsOf('b')).incoming[0].sharedWorld).toBeNull();
  });

  it('with "Shared worlds" only people who share a world can send a request', async () => {
    await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-b', settings: { friendRequestsFrom: 'shared_world' } });
    expect(await action('a', 'b', 'request')).toEqual({ status: 403, body: { error: 'no_shared_world' } });

    // A visit to the same world in the last 30 days counts.
    db.visits.push({ userId: 'a', worldId: 'w9', worldName: 'Cafe', accessedAt: new Date() });
    db.visits.push({ userId: 'b', worldId: 'w9', worldName: 'Cafe', accessedAt: new Date() });
    expect((await action('a', 'b', 'request')).body).toEqual({ relationship: 'request_sent' });
    expect((await friendsOf('b')).incoming[0].sharedWorld).toBe('Cafe');
  });

  it('respects "nobody" for friend requests', async () => {
    shareWorld('a', 'c');
    await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-c', settings: { friendRequestsFrom: 'nobody' } });
    expect(await action('a', 'c', 'request')).toEqual({ status: 403, body: { error: 'not_accepting_requests' } });
  });

  it(`caps open requests at ${MAX_OPEN_REQUESTS}`, async () => {
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) {
      db.friendships.push({
        id: `x${i}`, user1Id: 'a', user2Id: `z${i}`, status: i % 2 ? 'pending' : 'ignored',
        requestedById: 'a', createdAt: new Date(), acceptedAt: null,
      });
    }
    shareWorld('a', 'b');
    expect(await action('a', 'b', 'request')).toEqual({ status: 429, body: { error: 'too_many_open_requests' } });
  });

  describe('settings', () => {
    it('start at the defaults', async () => {
      const res = await get(getSettings, '/settings', { userUuid: 'uuid-a' });
      expect(await res.json()).toEqual({
        settings: { ringFrom: 'friends', friendRequestsFrom: 'anyone', findableByName: true, friendsSeeLocation: true },
      });
    });

    it('save partial changes and reject unknown fields or values', async () => {
      const res = await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-a', settings: { ringFrom: 'nobody', findableByName: true } });
      expect((await res.json()).settings).toEqual(expect.objectContaining({ ringFrom: 'nobody', findableByName: true, friendsSeeLocation: true }));

      expect((await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-a', settings: { ringFrom: 'everyone' } })).status).toBe(400);
      expect((await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-a', settings: { email: 'x' } })).status).toBe(400);
      expect((await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-a', settings: { toString: 'x' } })).status).toBe(400);
      expect((await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-a', settings: [] })).status).toBe(400);
      expect(db.preferences.find((p) => p.key === 'people.ringFrom')?.value).toBe('nobody');
    });

    it('a friend who hides their location shows shareLocation false and no last seen', async () => {
      shareWorld('a', 'b');
      await action('a', 'b', 'request');
      await action('b', 'a', 'accept');
      const at = new Date('2026-10-04T10:00:00Z');
      db.visits.push({ userId: 'b', worldId: 'w1', worldName: 'Main Hall', accessedAt: new Date('2026-10-03T10:00:00Z') });
      db.visits.push({ userId: 'b', worldId: 'w1', worldName: 'Main Hall', accessedAt: at });
      expect((await friendsOf('a')).friends[0]).toEqual(expect.objectContaining({ shareLocation: true, lastSeenAt: at.toISOString() }));

      await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-b', settings: { friendsSeeLocation: false } });
      expect((await friendsOf('a')).friends[0]).toEqual(expect.objectContaining({ shareLocation: false, lastSeenAt: null }));
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      addUser('d', 'Bilal Two');
      db.preferences.push({ userId: 'd', key: 'people.findableByName', value: false });
      db.members.push({ userId: 'b', worldId: 'w1', worldName: 'Main Hall', universeName: 'Bawes' });
      db.members.push({ userId: 'b', worldId: 'w2', worldName: 'Lab', universeName: 'Other' });
      db.members.push({ userId: 'b', worldId: 'w3', worldName: 'Third', universeName: 'Third' });
    });

    it('finds people unless they turned it off, with up to two universes', async () => {
      await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-b', settings: { findableByName: false } });
      expect(await (await get(search, '/search', { userUuid: 'uuid-a', q: 'bil' })).json()).toEqual({ results: [] });

      await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-b', settings: { findableByName: true } });
      const res = await get(search, '/search', { userUuid: 'uuid-a', q: 'BIL' });
      expect(await res.json()).toEqual({
        results: [{ uuid: 'uuid-b', name: 'Bilal', universes: ['Bawes', 'Other'], relationship: 'none' }],
      });
    });

    describe('the universes shown next to a name', () => {
      const universesOf = async (as: string, q = 'bil') => {
        const res = await get(search, '/search', { userUuid: `uuid-${as}`, q });
        return (await res.json()).results.map((r: { universes: string[] }) => r.universes);
      };
      const befriend = async (from: string, to: string) => {
        await action(from, to, 'request');
        await action(to, from, 'accept');
      };

      it('leaves out private worlds and private universes', async () => {
        db.members.length = 0;
        db.members.push({ userId: 'b', worldId: 'w1', worldName: 'Main Hall', universeName: 'Bawes' });
        db.members.push({ userId: 'b', worldId: 'w2', worldName: 'Lab', universeName: 'Secret universe', universePublic: false });
        db.members.push({ userId: 'b', worldId: 'w3', worldName: 'Back room', universeName: 'Quiet', worldPublic: false });
        expect(await universesOf('a')).toEqual([['Bawes']]);
      });

      it('shows none to a stranger when the person shows their passport to friends, but shows them to a friend', async () => {
        db.preferences.push({ userId: 'b', key: 'people.sharePassport', value: 'friends' });
        expect(await universesOf('a')).toEqual([[]]);
        await befriend('a', 'b');
        expect(await universesOf('a')).toEqual([['Bawes', 'Other']]);
      });

      it('shows none to anyone, friends included, when the person shows their passport to no one', async () => {
        db.preferences.push({ userId: 'b', key: 'people.sharePassport', value: 'nobody' });
        expect(await universesOf('a')).toEqual([[]]);
        await befriend('a', 'b');
        expect(await universesOf('a')).toEqual([[]]);
      });

      it('still finds the person by name when no universe may be shown', async () => {
        db.preferences.push({ userId: 'b', key: 'people.sharePassport', value: 'nobody' });
        const res = await get(search, '/search', { userUuid: 'uuid-a', q: 'bil' });
        expect((await res.json()).results.map((r: { uuid: string }) => r.uuid)).toEqual(['uuid-b']);
      });
    });

    it('finds someone who never touched the setting', async () => {
      const res = await get(search, '/search', { userUuid: 'uuid-a', q: 'bil' });
      expect((await res.json()).results.map((r: { uuid: string }) => r.uuid)).toEqual(['uuid-b']);
    });

    it('hides blocked pairs in both directions and never returns yourself', async () => {
      await action('b', 'a', 'block');
      expect((await (await get(search, '/search', { userUuid: 'uuid-a', q: 'bil' })).json()).results).toEqual([]);
      expect((await (await get(search, '/search', { userUuid: 'uuid-b', q: 'ali' })).json()).results).toEqual([]);
      expect((await (await get(search, '/search', { userUuid: 'uuid-a', q: 'ali' })).json()).results).toEqual([]);
    });

    it('needs 2 to 64 characters', async () => {
      expect((await get(search, '/search', { userUuid: 'uuid-a', q: ' b ' })).status).toBe(400);
      expect((await get(search, '/search', { userUuid: 'uuid-a', q: 'b'.repeat(65) })).status).toBe(400);
    });
  });

  it('places names Universe rooms and leaves other links unnamed', async () => {
    db.rooms.push({ universe: 'bawes', universeName: 'Bawes', world: 'hub', worldName: 'Hub', slug: 'lobby', name: 'Main Hall' });
    const known = 'https://play.example/@/bawes/hub/lobby';
    const res = await send(places, '/places', 'POST', { playUris: [known, 'https://play.example/@/bawes/hub/gone', 'https://play.example/~/maps/x.wam'] });
    expect(await res.json()).toEqual({
      places: {
        [known]: { universe: 'Bawes', world: 'Hub', room: 'Main Hall' },
        'https://play.example/@/bawes/hub/gone': null,
        'https://play.example/~/maps/x.wam': null,
      },
    });
    db.rooms.push({ universe: 'bawes', universeName: 'Bawes', world: 'hub', worldName: 'Hub', slug: 'café corner', name: 'Café' });
    db.rooms.push({ universe: 'bawes', universeName: 'Bawes', world: 'hub', worldName: 'Hub', slug: '50%-off', name: 'Sale' });
    const encoded = 'https://play.example/@/bawes/hub/caf%C3%A9%20corner';
    const percent = 'https://play.example/@/bawes/hub/50%25-off';
    const malformed = 'https://play.example/@/bawes/hub/50%';
    expect(await (await send(places, '/places', 'POST', { playUris: [encoded, percent, malformed] })).json()).toEqual({
      places: {
        [encoded]: { universe: 'Bawes', world: 'Hub', room: 'Café' },
        [percent]: { universe: 'Bawes', world: 'Hub', room: 'Sale' },
        [malformed]: null,
      },
    });
    expect((await send(places, '/places', 'POST', { playUris: Array(51).fill(known) })).status).toBe(400);
    expect((await send(places, '/places', 'POST', { playUris: [1] })).status).toBe(400);
    expect((await send(places, '/places', 'POST', { playUris: [known] }, {} as typeof auth)).status).toBe(401);
  });

  it('relationship returns the pair and the target ring and location settings', async () => {
    shareWorld('a', 'b');
    await action('a', 'b', 'request');
    await send(putSettings, '/settings', 'PUT', { userUuid: 'uuid-b', settings: { ringFrom: 'friends_and_members' } });
    const res = await get(relationship, '/relationship', { userUuid: 'uuid-b', targetUuid: 'uuid-a' });
    expect(await res.json()).toEqual({ relationship: 'request_received', target: { ringFrom: 'friends', friendsSeeLocation: true } });
    const back = await get(relationship, '/relationship', { userUuid: 'uuid-a', targetUuid: 'uuid-b' });
    expect(await back.json()).toEqual({ relationship: 'request_sent', target: { ringFrom: 'friends_and_members', friendsSeeLocation: true } });
    expect((await get(relationship, '/relationship', { userUuid: 'uuid-a', targetUuid: 'uuid-g' })).status).toBe(404);
  });
});
