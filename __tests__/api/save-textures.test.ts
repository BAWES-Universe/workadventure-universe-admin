/**
 * Saving a pick: refused when the Woka can't be worn in that world, otherwise recorded in the person's outfits with the
 * Recent rules (a try-on is dropped, 30 days, ten rows). Runs the real rules over an in-memory database.
 */
import { NextRequest } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }));

import { addOutfit, addSet, fakeDb, resetFakeDb, state } from '../helpers/fake-db';
import { POST as saveTextures } from '@/app/api/save-textures/route';
import { POST as saveCompanion } from '@/app/api/save-companion-texture/route';

const DAY = 24 * 3600 * 1000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function post(handler: typeof saveTextures, body: Record<string, unknown>, world = 'world-a') {
  const request = new NextRequest('http://localhost/api/save', {
    method: 'POST',
    headers: { Authorization: process.env.ADMIN_API_TOKEN as string, 'content-type': 'application/json' },
    body: JSON.stringify({ playUri: `http://play.test/@/uni/${world}/room`, userIdentifier: 'person-uuid', ...body }),
  });
  const response = await handler(request);
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
const pick = (...textures: string[]) => post(saveTextures, { textures });
const outfitsOf = () => state.outfits.map((row) => row.textureIds.join('|')).sort();

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});

beforeEach(() => {
  jest.clearAllMocks();
  resetFakeDb();
  state.universes.push({ id: 'un', slug: 'uni', name: 'Uni' });
  for (const slug of ['world-a', 'world-c']) state.worlds.push({ id: slug, slug, name: slug, universeId: 'un', universe: { slug: 'uni' } });
  state.users.push({ id: 'u1', uuid: 'person-uuid', email: 'p@example.test', companionTextureId: null });
  addSet({ id: 'std', layers: ['std-x', 'std-y', 'std-z'].map((textureId) => ({ textureId })), companions: [{ textureId: 'dog1' }] });
  addSet({ id: 'costume-c', layers: [{ textureId: 'cost-c1' }], scopes: [{ scopeType: 'world', scopeId: 'world-c' }], companions: [{ textureId: 'cape-pet' }] });
});

describe('POST /api/save-textures', () => {
  it('refuses a pick that is not wearable in the world it is picked in: 422 WOKA_NOT_ALLOWED, nothing saved', async () => {
    const result = await pick('cost-c1');
    expect(result).toEqual({ status: 422, body: { code: 'WOKA_NOT_ALLOWED' } });
    expect(await pick('nobody-has-this')).toMatchObject({ status: 422 });
    expect(await pick()).toMatchObject({ status: 422 });
    expect(state.outfits).toEqual([]);
    expect(state.avatars).toEqual([]);
    // …and saves it where it is allowed
    expect((await post(saveTextures, { textures: ['cost-c1'] }, 'world-c')).status).toBe(204);
    expect(outfitsOf()).toEqual(['cost-c1']);
  });

  it('records the pick as the Woka they wear now, and still keeps the world’s saved row', async () => {
    expect((await pick('std-x')).status).toBe(204);
    expect(outfitsOf()).toEqual(['std-x']);
    expect(state.avatars).toHaveLength(1);
    expect(state.avatars[0]).toMatchObject({ userId: 'u1', worldId: 'world-a', textureIds: ['std-x'] });
  });

  it('moves an outfit they wore before to the front: one row, last worn updated', async () => {
    addOutfit('u1', ['std-x'], minutesAgo(600));
    addOutfit('u1', ['std-y'], minutesAgo(500));
    await pick('std-x');
    expect(state.outfits).toHaveLength(2);
    const sorted = [...state.outfits].sort((a, b) => b.lastWornAt - a.lastWornAt);
    expect(sorted[0].textureIds).toEqual(['std-x']);
  });

  it('drops a try-on: an outfit worn once and swapped within five minutes does not stay', async () => {
    await pick('std-x');
    await pick('std-y');
    expect(outfitsOf()).toEqual(['std-y']);
  });

  it('still saves when another device dropped the same try-on a moment earlier', async () => {
    const stale = addOutfit('u1', ['std-x'], minutesAgo(1));
    state.outfits = []; // gone by the time this pick deletes it
    fakeDb.userOutfit.findFirst.mockResolvedValueOnce(stale);
    expect((await pick('std-y')).status).toBe(204);
    expect(outfitsOf()).toEqual(['std-y']);
  });

  it('keeps an outfit swapped after five minutes', async () => {
    addOutfit('u1', ['std-x'], minutesAgo(6));
    await pick('std-y');
    expect(outfitsOf()).toEqual(['std-x', 'std-y']);
  });

  it('never drops an outfit they wore before as a try-on, even when it is the newest and was swapped within five minutes', async () => {
    // worn first long ago, worn again two minutes ago
    addOutfit('u1', ['std-x'], minutesAgo(2), minutesAgo(900));
    await pick('std-y');
    expect(outfitsOf()).toEqual(['std-x', 'std-y']);
  });

  it('does not count picking the same outfit again as a try-on of itself', async () => {
    await pick('std-x');
    await pick('std-x');
    expect(outfitsOf()).toEqual(['std-x']);
  });

  it('removes outfits not worn for 30 days, except the newest', async () => {
    addOutfit('u1', ['std-x'], new Date(Date.now() - 31 * DAY));
    addOutfit('u1', ['std-y'], new Date(Date.now() - 29 * DAY));
    await pick('std-z');
    expect(outfitsOf()).toEqual(['std-y', 'std-z']);
  });

  it('never keeps more than ten outfits, the one just put on among them', async () => {
    for (let index = 0; index < 14; index += 1) addOutfit('u1', [`old-${index}`], minutesAgo(1000 + index * 10));
    await pick('std-x');
    expect(state.outfits).toHaveLength(10);
    expect(outfitsOf()).toContain('std-x');
    // the newest of the old ones stay
    expect(outfitsOf()).toContain('old-0');
    expect(outfitsOf()).not.toContain('old-13');
  });

  it('keeps the newest row even when everything else is older than 30 days', async () => {
    addOutfit('u1', ['std-x'], new Date(Date.now() - 40 * DAY));
    await pick('std-x');
    expect(outfitsOf()).toEqual(['std-x']);
  });

  it('answers 404, not 422, when the world is deleted between looking it up and checking the pick', async () => {
    fakeDb.world.findUnique.mockResolvedValueOnce(null);
    expect(await pick('std-x')).toMatchObject({ status: 404 });
    fakeDb.world.findUnique.mockResolvedValueOnce(null);
    expect(await post(saveCompanion, { texture: 'dog1' })).toMatchObject({ status: 404 });
    expect(state.outfits).toEqual([]);
  });

  it('rejects a request with textures that are not ids', async () => {
    expect((await post(saveTextures, { textures: [{ id: 'std-x' }] })).status).toBe(400);
  });
});

describe('POST /api/save-companion-texture', () => {
  it('refuses a companion not wearable in that world with 422, saves nothing', async () => {
    expect(await post(saveCompanion, { texture: 'cape-pet' })).toEqual({ status: 422, body: { code: 'WOKA_NOT_ALLOWED' } });
    expect(state.users[0].companionTextureId).toBeNull();
    expect(state.avatars).toEqual([]);
  });

  it('saves the companion on the person (and still in user_avatars), and none (null) is always allowed', async () => {
    expect((await post(saveCompanion, { texture: 'dog1' })).status).toBe(204);
    expect(state.users[0].companionTextureId).toBe('dog1');
    expect(state.avatars[0]).toMatchObject({ companionTextureId: 'dog1' });
    expect((await post(saveCompanion, { texture: 'cape-pet' }, 'world-c')).status).toBe(204);
    expect(state.users[0].companionTextureId).toBe('cape-pet');
    expect((await post(saveCompanion, { texture: null })).status).toBe(204);
    expect(state.users[0].companionTextureId).toBeNull();
  });
});
