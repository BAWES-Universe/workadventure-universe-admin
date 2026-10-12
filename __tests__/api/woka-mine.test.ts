/**
 * GET /api/woka/mine: what the game needs to show a signed-in person their Woka in one world: the Woka they wear now and
 * whether this world allows it, the one to suggest, their Recent list (at most four, allowed here, fresh) and companion.
 */
import { NextRequest } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }));

import { addOutfit, addSet, resetFakeDb, state } from '../helpers/fake-db';
import { GET as wokaMine } from '@/app/api/woka/mine/route';
import { GET as capabilities } from '@/app/api/capabilities/route';

const DAY = 24 * 3600 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

async function mine(world = 'world-d', uuid = 'person-uuid') {
  const roomUrl = `http://play.test/@/uni/${world}/room`;
  const request = new NextRequest(`http://localhost/api/woka/mine?roomUrl=${encodeURIComponent(roomUrl)}&uuid=${uuid}`, {
    headers: { Authorization: process.env.ADMIN_API_TOKEN as string },
  });
  const response = await wokaMine(request);
  return { status: response.status, body: await response.json() };
}
const names = (list: { textures: { id: string }[] }[]) => list.map((entry) => entry.textures.map((texture) => texture.id).join('+'));

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});

beforeEach(() => {
  resetFakeDb();
  state.universes.push({ id: 'un', slug: 'uni', name: 'Uni' });
  for (const [slug, name] of [['world-c', 'World C'], ['world-d', 'World D']]) {
    state.worlds.push({ id: slug, slug, name, universeId: 'un', universe: { slug: 'uni' } });
  }
  state.users.push({ id: 'u1', uuid: 'person-uuid', email: 'pat@example.test', isGuest: false, companionTextureId: null });
  addSet({
    id: 'std',
    layers: ['teal', 'rose', 'gold', 'plum', 'mint'].map((textureId) => ({ textureId, name: `Name ${textureId}` })).concat([
      { textureId: 'body-1', name: 'Body' },
    ]),
    companions: [{ textureId: 'dog1' }],
  });
  state.sets[0].layers.find((layer: { textureId: string }) => layer.textureId === 'body-1').layer = 'body';
  addSet({ id: 'crown', layers: [{ textureId: 'crown', name: 'Gold crown' }], scopes: [{ scopeType: 'world', scopeId: 'world-c' }], companions: [{ textureId: 'cape-pet' }] });
});

describe('GET /api/woka/mine', () => {
  it('knows a signed-in player by the email the game sends, as well as by their uuid', async () => {
    addOutfit('u1', ['teal'], daysAgo(2));
    addOutfit('u1', ['crown'], daysAgo(1));
    const byEmail = await mine('world-d', 'pat@example.test');
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.current).toMatchObject({ name: 'Gold crown', wearableHere: false });
    expect(names(byEmail.body.recent)).toEqual(['teal']);
    expect(byEmail.body.suggestion).toMatchObject({ lastWorn: true });
    expect((await mine('world-d', 'person-uuid')).body).toEqual(byEmail.body);
  });

  it('lists at most four Wokas, the one worn now first, newest first, never twice', async () => {
    ['mint', 'plum', 'gold', 'rose', 'teal'].forEach((id, index) => addOutfit('u1', [id], daysAgo(5 - index)));
    const { body } = await mine();
    expect(names(body.recent)).toEqual(['teal', 'rose', 'gold', 'plum']);
    expect(body.recent.map((entry: { current: boolean }) => entry.current)).toEqual([true, false, false, false]);
    expect(body.current).toMatchObject({ name: 'Name teal', wearableHere: true });
    expect(body.recent[0]).toMatchObject({ name: 'Name teal', textures: [{ id: 'teal', url: 'https://play.test/teal.png' }] });
  });

  it('hides Wokas this world does not allow, and ones not worn for 30 days', async () => {
    addOutfit('u1', ['plum'], daysAgo(40)); // too old
    addOutfit('u1', ['crown'], daysAgo(3)); // only in World C
    addOutfit('u1', ['rose'], daysAgo(2));
    addOutfit('u1', ['teal'], daysAgo(1));
    const { body } = await mine('world-d');
    expect(names(body.recent)).toEqual(['teal', 'rose']);
    expect((await mine('world-c')).body.recent.map((entry: { textures: { id: string }[] }) => entry.textures[0].id)).toEqual(['teal', 'rose', 'crown']);
  });

  it('keeps the Woka worn now however old, as long as this world allows it', async () => {
    addOutfit('u1', ['teal'], daysAgo(90));
    const { body } = await mine();
    expect(names(body.recent)).toEqual(['teal']);
    expect(body.recent[0].current).toBe(true);
  });

  it('when the Woka worn now is not allowed here: says why, leaves it out of Recent, and suggests the newest allowed one', async () => {
    addOutfit('u1', ['teal'], daysAgo(2));
    addOutfit('u1', ['crown'], daysAgo(1));
    const { body } = await mine('world-d');
    expect(body.current).toEqual({
      textures: [{ id: 'crown', url: 'https://play.test/crown.png' }],
      name: 'Gold crown',
      wearableHere: false,
      reason: 'other_place',
      placeName: 'World C',
    });
    expect(names(body.recent)).toEqual(['teal']);
    expect(body.recent[0].current).toBe(false);
    expect(body.suggestion).toEqual({ textures: [{ id: 'teal', url: 'https://play.test/teal.png' }], name: 'Name teal', lastWorn: true });
  });

  it('suggests the first Woka of the world’s list, not marked last worn, when nothing worn lately is allowed', async () => {
    addOutfit('u1', ['crown'], daysAgo(1));
    const { body } = await mine('world-d');
    expect(body.recent).toEqual([]);
    expect(body.suggestion).toEqual({ textures: [{ id: 'teal', url: 'https://play.test/teal.png' }], name: 'Name teal', lastWorn: false });
  });

  it('gives an outfit of several layers no name, and a single non-Woka layer no name either', async () => {
    addOutfit('u1', ['body-1', 'teal'], daysAgo(1));
    addOutfit('u1', ['body-1'], daysAgo(0.5));
    const { body } = await mine();
    expect(body.recent.map((entry: { name: string | null }) => entry.name)).toEqual([null, null]);
  });

  it('returns the companion they wear and whether it works here', async () => {
    addOutfit('u1', ['teal'], daysAgo(1));
    state.users[0].companionTextureId = 'cape-pet';
    expect((await mine('world-d')).body.companion).toEqual({ id: 'cape-pet', url: 'https://play.test/cape-pet.png', wearableHere: false });
    expect((await mine('world-c')).body.companion).toMatchObject({ wearableHere: true });
    state.users[0].companionTextureId = null;
    expect((await mine()).body.companion).toBeNull();
  });

  it('has no current Woka for someone who never picked one', async () => {
    const { body } = await mine();
    expect(body.current).toBeNull();
    expect(body.recent).toEqual([]);
    expect(body.suggestion).toMatchObject({ lastWorn: false });
  });

  it('answers 404 for a guest, an unknown uuid and an unknown world, and 400 for a bad address', async () => {
    state.users.push({ id: 'g1', uuid: 'guest-uuid', isGuest: true, companionTextureId: null });
    expect((await mine('world-d', 'guest-uuid')).status).toBe(404);
    expect((await mine('world-d', 'nobody')).status).toBe(404);
    expect((await mine('no-such-world')).status).toBe(404);
    const bad = await wokaMine(new NextRequest('http://localhost/api/woka/mine?roomUrl=nonsense&uuid=person-uuid', { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } }));
    expect(bad.status).toBe(400);
  });

  it('needs the admin token', async () => {
    const response = await wokaMine(new NextRequest('http://localhost/api/woka/mine?roomUrl=x&uuid=y'));
    expect(response.status).toBe(401);
  });

  it('is announced as a capability', async () => {
    expect(await (await capabilities(new NextRequest('http://localhost/api/capabilities'))).json()).toMatchObject({ 'api/woka/mine': 'v1' });
  });
});
