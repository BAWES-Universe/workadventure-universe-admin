/**
 * The Brick on the map: a bot's Woka list starts with the "Bricks" group (the twelve Brick colours' map sprites), a
 * bot's Brick look resolves to its sprite when the bot joins a room, and none of it reaches a person's own Woka picker
 * or what a person may wear. Everything else in the list stays as it was.
 */
import { NextRequest } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/db', () => ({ prisma: require('../helpers/fake-db').fakeDb }));

import { addSet, fakeDb, resetFakeDb, state } from '../helpers/fake-db';
import { GET as wokaList } from '@/app/api/woka/list/route';
import { resolveTextureUrls } from '@/lib/avatar-catalog-validator';
import { wearableHere } from '@/lib/woka-wearable';
import { getWokaList } from '@/lib/wokas';
import { BRICK_LOOKS } from '@/lib/brick-make';
import { BRICK_SPRITES, brickSpriteTextures, withBrickSprites } from '@/lib/brick-sprites';

const PLAY = (process.env.PLAY_URL || 'http://play.workadventure.localhost').replace(/\/$/, '');
const roomUrl = 'http://play.test/@/uni/world-a/room';

type List = { woka: { collections: { name: string; textures: { id: string; name: string; url: string }[] }[] } };

async function list(context: string | null) {
  const query = `roomUrl=${encodeURIComponent(roomUrl)}${context ? `&context=${context}` : ''}`;
  const response = await wokaList(new NextRequest(`http://localhost/api/woka/list?${query}`, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } }));
  return { status: response.status, body: (await response.json()) as List };
}
const ids = (body: List) => body.woka.collections.flatMap((collection) => collection.textures.map((texture) => texture.id));

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});

beforeEach(() => {
  resetFakeDb();
  state.universes.push({ id: 'un', slug: 'uni', name: 'Uni' });
  state.worlds.push({ id: 'world-a', slug: 'world-a', name: 'world-a', universeId: 'un', universe: { slug: 'uni' } });
  addSet({ id: 'std', name: 'Default', layers: [{ textureId: 'male1' }, { textureId: 'female2' }] });
  addSet({ id: 'hidden', name: 'Hidden', visibility: 'hidden', layers: [{ textureId: 'hidden-1' }] });
});

describe('the twelve Brick sprites', () => {
  it('are the twelve Brick looks, in the order a new Brick tries them', () => {
    expect(BRICK_SPRITES.map((sprite) => sprite.id)).toEqual([...BRICK_LOOKS]);
  });

  it('are served from the game, like every Woka sheet', () => {
    const [orange, , , , , teal] = brickSpriteTextures('http://play.test/');
    expect(orange).toEqual({ id: 'brick-orange', name: 'Orange Brick', url: 'http://play.test/resources/characters/bricks/brick-orange.png', position: 0 });
    expect(teal.url).toBe('http://play.test/resources/characters/bricks/brick-teal.png');
  });
});

describe('GET /api/woka/list', () => {
  it('opens a bot’s list with the Bricks group and leaves the rest of it as it was', async () => {
    const person = (await list(null)).body;
    const bot = (await list('bot')).body;
    expect(bot.woka.collections[0].name).toBe('Bricks');
    expect(bot.woka.collections[0].textures.map((texture) => texture.id)).toEqual([...BRICK_LOOKS]);
    expect(bot.woka.collections[0].textures[0].url).toBe(`${PLAY}/resources/characters/bricks/brick-orange.png`);
    // the other groups come after, exactly as a bot saw them before (a bot also sees hidden sets)
    expect(bot.woka.collections.slice(1).flatMap((collection) => collection.textures.map((texture) => texture.id))).toEqual(['male1', 'female2', 'hidden-1']);
    expect(person.woka.collections.map((collection) => collection.name)).toEqual(['Default']);
  });

  it('never puts the Brick colours in a person’s own Woka picker', async () => {
    const asked = await list(null);
    expect(asked.status).toBe(200);
    expect(ids(asked.body).filter((id) => id.startsWith('brick-'))).toEqual([]);
  });

  it('still gives a bot the Bricks, then the built-in Wokas, when the catalog has no sets', async () => {
    state.sets = [];
    const bot = (await list('bot')).body;
    expect(bot.woka.collections[0].name).toBe('Bricks');
    expect(bot.woka.collections.slice(1)).toEqual(getWokaList(PLAY).woka.collections);
    expect(ids((await list(null)).body)).toEqual(ids({ woka: getWokaList(PLAY).woka } as unknown as List));
  });
});

describe('withBrickSprites', () => {
  it('does not double a Brick look a set already holds, and changes nothing else', () => {
    const own = { woka: { collections: [{ name: 'Mine', textures: [{ id: 'brick-red' }] }] }, body: { collections: [] } };
    const out = withBrickSprites(own, PLAY);
    expect(out.woka.collections[0].textures.map((texture) => texture.id)).not.toContain('brick-red');
    expect(out.woka.collections[0].textures).toHaveLength(11);
    expect(out.woka.collections[1]).toBe(own.woka.collections[0]);
    expect(out.body).toBe(own.body);
    expect(own.woka.collections).toHaveLength(1);
  });
});

describe('a bot joining a room with a Brick look', () => {
  it('gets its sprite, whether or not the catalog has sets', async () => {
    const wearing = await resolveTextureUrls(fakeDb as never, ['brick-teal'], 'world-a', 'un', PLAY);
    expect(wearing).toEqual({ valid: true, textures: [{ id: 'brick-teal', name: 'Teal Brick', url: `${PLAY}/resources/characters/bricks/brick-teal.png`, layer: [] }] });
    state.sets = [];
    expect((await resolveTextureUrls(fakeDb as never, ['brick-teal'], 'world-a', 'un', PLAY)).textures[0].url).toBe(`${PLAY}/resources/characters/bricks/brick-teal.png`);
  });

  it('still resolves every other texture as before, and still refuses a Brick colour that is not one', async () => {
    expect((await resolveTextureUrls(fakeDb as never, ['male1'], 'world-a', 'un', PLAY)).textures.map((texture) => texture.id)).toEqual(['male1']);
    expect((await resolveTextureUrls(fakeDb as never, ['brick-gold'], 'world-a', 'un', PLAY)).valid).toBe(false);
    expect((await resolveTextureUrls(fakeDb as never, ['male1', 'brick-gold'], 'world-a', 'un', PLAY)).valid).toBe(false);
  });
});

describe('a person', () => {
  it('can never wear a Brick colour', async () => {
    const ctx = { worldId: 'world-a', universeId: 'un', userId: null, membershipTags: [] };
    for (const look of BRICK_LOOKS) expect((await wearableHere([look], ctx)).wearable).toBe(false);
    expect((await wearableHere(['male1'], ctx)).wearable).toBe(true);
  });
});
