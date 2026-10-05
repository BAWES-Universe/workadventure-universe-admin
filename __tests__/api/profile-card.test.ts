/**
 * GET /api/profile/[uuid]: someone's words and links. Embedded, it is the card under their avatar and name in the
 * game's player popup; someone who has written nothing gets no line saying so, and the card has no height.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    visitCard: { findUnique: jest.fn() },
  },
}));

import { prisma } from '@/lib/db';
import { GET } from '@/app/api/profile/[uuid]/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

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
  beforeEach(() => jest.clearAllMocks());

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
});
