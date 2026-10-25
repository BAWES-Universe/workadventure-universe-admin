/**
 * Room info names a room for the game's Discord report: room, world and universe names, plus the universe's own shade.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: { room: { findFirst: jest.fn() } },
}));

import { prisma } from '@/lib/db';
import { universeColour } from '@/lib/universe-colour';
import { GET } from '@/app/api/room/info/route';

const findFirst = (prisma as unknown as { room: { findFirst: jest.Mock } }).room.findFirst;

const ask = (slug?: string) =>
  GET(new NextRequest(`http://localhost/api/room/info${slug === undefined ? '' : `?slug=${encodeURIComponent(slug)}`}`));

describe('GET /api/room/info', () => {
  beforeEach(() => findFirst.mockReset());

  it('returns the names and the universe colour Orbit uses for that universe', async () => {
    findFirst.mockResolvedValue({ name: 'Headquarters', world: { name: 'Office', universe: { id: 'u-bawes', name: 'BAWES' } } });

    const response = await ask('bawes/office/hq');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      roomName: 'Headquarters',
      worldName: 'Office',
      universeName: 'BAWES',
      universeColour: universeColour('u-bawes'),
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'hq', world: { slug: 'office', universe: { slug: 'bawes' } } },
        select: expect.objectContaining({
          world: { select: { name: true, universe: { select: { id: true, name: true } } } },
        }),
      }),
    );
  });

  it('keeps the same colour for the same universe on every call', async () => {
    findFirst.mockResolvedValue({ name: 'Lobby', world: { name: 'Town', universe: { id: 'u-42', name: 'Forty Two' } } });

    const first = await (await ask('forty-two/town/lobby')).json();
    const second = await (await ask('forty-two/town/lobby')).json();

    expect(first.universeColour).toMatch(/^#[0-9a-f]{6}$/);
    expect(second.universeColour).toBe(first.universeColour);
  });

  it('answers 404 for a room that does not exist', async () => {
    findFirst.mockResolvedValue(null);

    expect((await ask('nope/nope/nope')).status).toBe(404);
  });

  it('answers 400 without a slug or with a slug that is not universe/world/room', async () => {
    expect((await ask()).status).toBe(400);
    expect((await ask('only/two')).status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
