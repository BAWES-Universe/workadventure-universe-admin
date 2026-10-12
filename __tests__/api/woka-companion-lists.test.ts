/**
 * The two pickers know a signed-in player the way saving does: by the email the game sends as well as by their uuid.
 * The Woka picker then shows their world's members-only and directly granted Wokas, and the companion picker lists only
 * companions that saving would accept (same sets, same person, same dates).
 */
import { NextRequest } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }));

import { addSet, resetFakeDb, state } from '../helpers/fake-db';
import { GET as wokaList } from '@/app/api/woka/list/route';
import { GET as companionList } from '@/app/api/companion/list/route';
import { companionWearableHere } from '@/lib/woka-wearable';

const EMAIL = 'pat@example.test';
const DAY = 24 * 3600 * 1000;

async function call(handler: typeof wokaList, who: string | null, world = 'world-a') {
  const roomUrl = `http://play.test/@/uni/${world}/room`;
  const person = who ? `&uuid=${encodeURIComponent(who)}` : '';
  const request = new NextRequest(`http://localhost/api/x?roomUrl=${encodeURIComponent(roomUrl)}${person}`, {
    headers: { Authorization: process.env.ADMIN_API_TOKEN as string },
  });
  const response = await handler(request);
  return { status: response.status, body: await response.json() };
}
const wokaIds = (body: { woka: { collections: { textures: { id: string }[] }[] } }) => body.woka.collections.flatMap((collection) => collection.textures.map((texture) => texture.id));
const companionIds = (body: { textures: { id: string }[] }[]) => body.flatMap((collection) => collection.textures.map((texture) => texture.id)).sort();

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});

beforeEach(() => {
  resetFakeDb();
  state.universes.push({ id: 'un', slug: 'uni', name: 'Uni' });
  for (const slug of ['world-a', 'world-b']) {
    state.worlds.push({ id: slug, slug, name: slug, universeId: 'un', universe: { slug: 'uni' } });
  }
  state.users.push({ id: 'u1', uuid: 'person-uuid', email: EMAIL, isGuest: false, companionTextureId: null });
  state.members.push({ userId: 'u1', worldId: 'world-a', tags: ['vip'] });
  addSet({ id: 'std', layers: [{ textureId: 'std-x' }], companions: [{ textureId: 'dog1' }] });
  addSet({
    id: 'vip',
    visibility: 'restricted',
    layers: [{ textureId: 'vip-1' }],
    companions: [{ textureId: 'vip-pet' }],
    policies: [{ subjectType: 'membership_tag', subjectValue: 'vip' }],
  });
});

describe('GET /api/woka/list, who is asking', () => {
  it('shows a member their world’s members-only Wokas, asking by email or by uuid, and a stranger only the public ones', async () => {
    expect(wokaIds((await call(wokaList, EMAIL)).body)).toEqual(['std-x', 'vip-1']);
    expect(wokaIds((await call(wokaList, 'person-uuid')).body)).toEqual(['std-x', 'vip-1']);
    expect(wokaIds((await call(wokaList, null)).body)).toEqual(['std-x']);
    expect(wokaIds((await call(wokaList, 'nobody@example.test')).body)).toEqual(['std-x']);
    // not a member of world-b
    expect(wokaIds((await call(wokaList, EMAIL, 'world-b')).body)).toEqual(['std-x']);
  });

  it('shows the Wokas granted to them directly, asking by email', async () => {
    addSet({ id: 'gift', visibility: 'hidden', layers: [{ textureId: 'gift-1' }] });
    state.grants.push({ userId: 'u1', avatarSetId: 'gift', isActive: true, grantType: 'select', expiresAt: null });
    expect(wokaIds((await call(wokaList, EMAIL, 'world-b')).body)).toEqual(['std-x', 'gift-1']);
    expect(wokaIds((await call(wokaList, null, 'world-b')).body)).toEqual(['std-x']);
  });
});

describe('GET /api/companion/list, only what saving accepts', () => {
  it('leaves out hidden, invite-only, members-only (for non-members) and expired companions', async () => {
    addSet({ id: 'hidden', visibility: 'hidden', companions: [{ textureId: 'hidden-pet' }] });
    addSet({ id: 'invite', visibility: 'assigned_only', companions: [{ textureId: 'invite-pet' }] });
    addSet({ id: 'ended', availableUntil: new Date(Date.now() - DAY), companions: [{ textureId: 'ended-pet' }] });
    addSet({ id: 'later', availableFrom: new Date(Date.now() + DAY), companions: [{ textureId: 'later-pet' }] });
    expect(companionIds((await call(companionList, null)).body)).toEqual(['dog1']);
    expect(companionIds((await call(companionList, EMAIL, 'world-b')).body)).toEqual(['dog1']);
  });

  it('lists a member their members-only companions and a person the invite-only ones given to them, asking by email', async () => {
    addSet({ id: 'invite', visibility: 'assigned_only', companions: [{ textureId: 'invite-pet' }] });
    expect(companionIds((await call(companionList, EMAIL)).body)).toEqual(['dog1', 'vip-pet']);
    state.grants.push({ userId: 'u1', avatarSetId: 'invite', isActive: true, grantType: 'assigned_only', expiresAt: null });
    expect(companionIds((await call(companionList, EMAIL)).body)).toEqual(['dog1', 'invite-pet', 'vip-pet']);
    expect(companionIds((await call(companionList, 'person-uuid')).body)).toEqual(['dog1', 'invite-pet', 'vip-pet']);
  });

  it('lists nothing that saving would refuse', async () => {
    addSet({ id: 'hidden', visibility: 'hidden', companions: [{ textureId: 'hidden-pet' }] });
    addSet({ id: 'invite', visibility: 'assigned_only', companions: [{ textureId: 'invite-pet' }] });
    addSet({ id: 'ended', availableUntil: new Date(Date.now() - DAY), companions: [{ textureId: 'ended-pet' }] });
    const ctx = (tags: string[]) => ({ worldId: 'world-a', universeId: 'un', userId: 'u1', membershipTags: tags });
    for (const [who, tags] of [[EMAIL, ['vip']], [null, []]] as const) {
      const listed = companionIds((await call(companionList, who)).body);
      expect(listed.length).toBeGreaterThan(0);
      for (const id of listed) expect((await companionWearableHere(id, ctx(tags as string[]))).wearable).toBe(true);
    }
  });
});
