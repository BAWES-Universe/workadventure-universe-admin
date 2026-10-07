/**
 * GET /api/profile/[uuid]: someone's words and links. Embedded, it is the card under their avatar and name in the
 * game's player popup; someone who has written nothing gets no line saying so, and the card has no height.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    visitCard: { findUnique: jest.fn() },
    userPreference: { findMany: jest.fn() },
    roomAccess: { groupBy: jest.fn() },
    world: { findMany: jest.fn() },
    friendship: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/profile/[uuid]/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $queryRaw: jest.Mock };
const session = getSessionUser as jest.Mock;

async function html(card: { bio: string | null; links: Array<{ label: string; url: string }> }, embed: boolean) {
  db.user.findUnique.mockResolvedValue({ id: 'u1', name: 'Khalid' });
  db.visitCard.findUnique.mockResolvedValue(card);
  const url = new URL('http://localhost:3333/api/profile/abc');
  if (embed) url.searchParams.set('embed', 'true');
  const res = await GET(new NextRequest(url, { headers: { Accept: 'text/html' } }), {
    params: Promise.resolve({ uuid: 'abc' }),
  });
  return res.text();
}

describe('profile card', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    db.userPreference.findMany.mockResolvedValue([]);
    db.roomAccess.groupBy.mockResolvedValue([]);
    db.world.findMany.mockResolvedValue([]);
    db.friendship.findFirst.mockResolvedValue(null);
    db.$queryRaw.mockResolvedValue([{ days: 3 }]);
    session.mockResolvedValue(null);
  });

  it('shows nothing in the game for someone who has written nothing', async () => {
    const page = await html({ bio: null, links: [] }, true);
    expect(page).not.toContain('No profile yet');
    expect(page).not.toContain('<main');
    // Still tells the game its height, so the popup shrinks to nothing.
    expect(page).toContain('cvIframeSize');
  });

  it('shows the name only on the full page for someone who has written nothing', async () => {
    const page = await html({ bio: '', links: [] }, false);
    expect(page).not.toContain('No profile yet');
    expect(page).toContain('<h1>Khalid</h1>');
  });

  it('shows the bio and web links in the game', async () => {
    const page = await html(
      {
        bio: 'Builds worlds',
        links: [
          { label: 'Site', url: 'https://bawes.net' },
          { label: 'Bad', url: 'javascript:alert(1)' },
        ],
      },
      true,
    );
    expect(page).toContain('<main class="profile">');
    expect(page).toContain('Builds worlds');
    expect(page).toContain('href="https://bawes.net"');
    expect(page).not.toContain('javascript:');
  });

  describe('passport', () => {
    const visits = (worldId: string, count: number, first = '2026-01-12T10:00:00Z') => ({
      worldId,
      _count: { _all: count },
      _min: { accessedAt: new Date(first) },
    });
    const world = (id: string, name: string, extra: { isPublic?: boolean; universePublic?: boolean } = {}) => ({
      id,
      name,
      isPublic: extra.isPublic ?? true,
      universe: { id: `u-${id}`, name: `Universe of ${name}`, isPublic: extra.universePublic ?? true },
    });
    beforeEach(() => {
      db.roomAccess.groupBy.mockResolvedValue([visits('hq', 212), visits('nebula', 64), visits('studio', 23), visits('garage', 4), visits('secret', 99)]);
      db.world.findMany.mockResolvedValue([
        world('hq', 'HQ'),
        world('nebula', 'Nebula'),
        world('studio', 'Studio'),
        world('garage', 'Garage'),
        world('secret', 'Secret', { isPublic: false }),
      ]);
    });

    it('shows the three most visited public worlds as stamps in the game, and never a private one', async () => {
      const page = await html({ bio: 'Hi', links: [] }, true);
      expect(page).toContain('<ul class="stamps"');
      expect(page).toContain('<strong>HQ</strong>');
      expect(page).toContain('212 visits');
      expect(page).toContain('<strong>Nebula</strong>');
      expect(page).toContain('<strong>Studio</strong>');
      expect(page).not.toContain('Garage');
      expect(page).not.toContain('Secret');
    });

    it('shows more stamps on the full page', async () => {
      const page = await html({ bio: 'Hi', links: [] }, false);
      expect(page).toContain('<strong>Garage</strong>');
      expect(page).not.toContain('Secret');
    });

    it('says "1 visit" for one visit', async () => {
      db.roomAccess.groupBy.mockResolvedValue([visits('hq', 1)]);
      expect(await html({ bio: 'Hi', links: [] }, true)).toContain('1 visit<');
    });

    it('shows stamps even for someone with no bio or links, so the game card is not empty', async () => {
      const page = await html({ bio: null, links: [] }, true);
      expect(page).toContain('<main class="profile">');
      expect(page).toContain('<strong>HQ</strong>');
    });

    it('shows nothing when they show their passport to no one', async () => {
      db.userPreference.findMany.mockResolvedValue([{ key: 'people.sharePassport', value: 'nobody' }]);
      const page = await html({ bio: 'Hi', links: [] }, true);
      expect(page).not.toContain('<ul class="stamps"');
      expect(db.roomAccess.groupBy).not.toHaveBeenCalled();
    });

    it('shows a friends-only passport to a signed-in friend, and to no one else', async () => {
      db.userPreference.findMany.mockResolvedValue([{ key: 'people.sharePassport', value: 'friends' }]);
      expect(await html({ bio: 'Hi', links: [] }, true)).not.toContain('<ul class="stamps"');

      session.mockResolvedValue({ id: 'someone', uuid: 'x' });
      expect(await html({ bio: 'Hi', links: [] }, true)).not.toContain('<ul class="stamps"');

      db.friendship.findFirst.mockResolvedValue({ id: 'f1' });
      expect(await html({ bio: 'Hi', links: [] }, true)).toContain('<strong>HQ</strong>');
    });

    it('keeps the card when the passport cannot be read', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      db.roomAccess.groupBy.mockRejectedValue(new Error('db down'));
      const page = await html({ bio: 'Builds worlds', links: [] }, true);
      expect(page).toContain('Builds worlds');
      expect(page).not.toContain('<ul class="stamps"');
    });

    it('escapes a world name', async () => {
      db.roomAccess.groupBy.mockResolvedValue([visits('hq', 2)]);
      db.world.findMany.mockResolvedValue([world('hq', '<img src=x onerror=alert(1)>')]);
      const page = await html({ bio: 'Hi', links: [] }, true);
      expect(page).not.toContain('<img src=x');
      expect(page).toContain('&lt;img src=x');
    });
  });
});
