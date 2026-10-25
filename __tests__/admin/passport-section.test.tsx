/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { ActivitySection, PassportSection } from '@/app/admin/components/passport';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const stamp = (worldId: string, world: string, universe: string, visits: number, since: string) => ({
  worldId,
  world,
  universe: { id: `u-${universe}`, name: universe },
  visits,
  since,
});
const passport = {
  stamps: [stamp('hq', 'HQ', 'BAWES', 212, '2026-01-12T08:00:00Z'), stamp('studio', 'Studio', 'Mishari’s universe', 1, '2026-03-19T08:00:00Z')],
  worlds: 2,
  universes: 2,
  since: '2026-01-12T08:00:00Z',
  days: 84,
};
const answer = (body: unknown, ok = true) => fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });

beforeEach(() => fetchMock.mockReset());

describe('Your passport', () => {
  it('counts worlds and universes, says since when, and stamps each world', async () => {
    answer({ passport, audience: 'everyone' });
    render(<PassportSection />);
    const section = await screen.findByTestId('passport');
    expect(within(section).getByText('2 worlds')).toBeTruthy();
    expect(within(section).getByText('2 universes')).toBeTruthy();
    expect(within(section).getByText('Since 12 Jan 2026 · 84 days in Universe')).toBeTruthy();
    const stamps = within(section).getAllByTestId('passport-stamp');
    expect(stamps).toHaveLength(2);
    expect(within(stamps[0]).getByText('HQ')).toBeTruthy();
    expect(within(stamps[0]).getByText('212 visits')).toBeTruthy();
    expect(within(stamps[0]).getByText('since 12 Jan 2026')).toBeTruthy();
    expect(within(stamps[1]).getByText('1 visit')).toBeTruthy();
  });

  it('says who sees it, with a way to change it', async () => {
    for (const [audience, text] of [
      ['everyone', 'Everyone can see this'],
      ['friends', 'Only your friends can see this'],
      ['nobody', 'Only you can see this'],
    ] as const) {
      answer({ passport, audience });
      const { unmount } = render(<PassportSection />);
      const line = await screen.findByTestId('passport-visible');
      expect(line.textContent).toContain(text);
      expect(within(line).getByRole('link', { name: 'Who can see me' }).getAttribute('href')).toBe('/admin/sharing');
      unmount();
    }
  });

  it('says what a passport is when nothing has been stamped yet', async () => {
    answer({ passport: { stamps: [], worlds: 0, universes: 0, since: null, days: 0 }, audience: 'everyone' });
    render(<PassportSection />);
    expect(await screen.findByText('Your passport gets a stamp for every world you visit.')).toBeTruthy();
  });

  it('stays out of the page when it cannot be read', async () => {
    answer({}, false);
    const { container } = render(<PassportSection />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/passport'));
    expect(container.textContent).toBe('');
  });
});

describe('Your passport on You, as others see it', () => {
  const many = {
    ...passport,
    stamps: [
      stamp('hq', 'HQ', 'BAWES', 212, '2026-01-12T08:00:00Z'),
      stamp('lab', 'Lab', 'BAWES', 90, '2026-02-12T08:00:00Z'),
      stamp('shop', 'Shopfront', 'Plugn', 40, '2026-02-14T08:00:00Z'),
      stamp('cafe', 'Cafe', 'Plugn', 9, '2026-03-01T08:00:00Z'),
      stamp('studio', 'Studio', 'Mishari’s universe', 1, '2026-03-19T08:00:00Z'),
    ],
    worlds: 5,
  };
  // Lab is a private world: the card skips it.
  const card = [many.stamps[0], many.stamps[2], many.stamps[3]];

  it('shows the three stamps on your card in the game, small, with View all for every stamp', async () => {
    answer({ passport: many, card, audience: 'everyone' });
    render(<PassportSection small />);
    const section = await screen.findByTestId('passport');
    const stamps = within(section).getAllByTestId('passport-stamp');
    expect(stamps.map((item) => item.querySelector('strong')?.textContent)).toEqual(['HQ', 'Shopfront', 'Cafe']);
    expect(within(stamps[0]).queryByText('BAWES')).toBeNull();
    expect(within(stamps[0]).queryByText(/since/)).toBeNull();
    expect(within(section).getByText('5 worlds')).toBeTruthy();
    expect(within(section).getByText('What people see on your card in the game.')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/admin/you/passport');
  });

  it('says friends see it when only friends do', async () => {
    answer({ passport: many, card, audience: 'friends' });
    render(<PassportSection small />);
    expect(await screen.findByText('What your friends see on your card in the game.')).toBeTruthy();
  });

  it('keeps your own top three and says the card shows none when nobody sees your stamps', async () => {
    for (const [audience, shown] of [
      ['nobody', card],
      ['everyone', []],
    ] as const) {
      answer({ passport: many, card: shown, audience });
      const { unmount } = render(<PassportSection small />);
      const section = await screen.findByTestId('passport');
      expect(within(section).getAllByTestId('passport-stamp').map((item) => item.querySelector('strong')?.textContent)).toEqual(['HQ', 'Lab', 'Shopfront']);
      expect(within(section).getByText('Your card in the game shows no stamps.')).toBeTruthy();
      unmount();
    }
  });

  it('gives a word too long for a small stamp smaller type', async () => {
    answer({ passport: many, card, audience: 'everyone' });
    render(<PassportSection small />);
    const section = await screen.findByTestId('passport');
    const names = within(section).getAllByTestId('passport-stamp').map((item) => item.querySelector('strong'));
    expect(names[0]?.getAttribute('data-long')).toBeNull();
    expect(names[1]?.getAttribute('data-long')).toBe('long');
    expect(names[2]?.getAttribute('data-long')).toBeNull();
  });

  it('has no View all and the usual line for someone with no stamps yet', async () => {
    answer({ passport: { stamps: [], worlds: 0, universes: 0, since: null, days: 0 }, card: [], audience: 'everyone' });
    render(<PassportSection small />);
    expect(await screen.findByText('Your passport gets a stamp for every world you visit.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'View all' })).toBeNull();
  });

  it('shows every stamp in full on its own page, without a heading of its own', async () => {
    answer({ passport: many, card, audience: 'everyone' });
    render(<PassportSection bare />);
    const section = await screen.findByTestId('passport');
    expect(within(section).getAllByTestId('passport-stamp')).toHaveLength(5);
    expect(within(section).queryByRole('heading')).toBeNull();
    expect(within(section).queryByRole('link', { name: 'View all' })).toBeNull();
    expect(within(section).getByTestId('passport-visible')).toBeTruthy();
  });
});

describe("Someone else's passport", () => {
  it("shows the stamps they share with you, under their name, without the 'who can see me' line", async () => {
    answer({ stamps: passport.stamps.slice(0, 1), passport });
    render(<PassportSection userId="sara" name="Sara" />);
    const section = await screen.findByTestId('passport');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/sara/passport');
    expect(within(section).getByText('Sara’s passport')).toBeTruthy();
    expect(within(section).getByText('2 worlds')).toBeTruthy();
    expect(within(section).getAllByTestId('passport-stamp')).toHaveLength(2);
    expect(within(section).queryByTestId('passport-visible')).toBeNull();
  });

  it('shows nothing when they hide it from you, or there is nothing to show', async () => {
    answer({ stamps: [], passport: null });
    const { container, unmount } = render(<PassportSection userId="sara" name="Sara" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe('');
    unmount();
    answer({ stamps: [], passport: { stamps: [], worlds: 0, universes: 0, since: null, days: 0 } });
    const second = render(<PassportSection userId="sara" name="Sara" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe('');
  });
});

describe('Your activity', () => {
  it('lists what happened with how long ago, each leading to its page, and says only you see it', async () => {
    const recent = new Date(Date.now() - 5 * 3600_000).toISOString();
    answer({
      events: [
        { id: 'a', kind: 'world', text: 'Mishari invited you to Workshop as a member', at: recent, href: '/admin/invitations/i1' },
        { id: 'b', kind: 'star', text: 'You starred HQ Lobby', at: recent, href: null },
      ],
    });
    render(<ActivitySection />);
    const section = await screen.findByTestId('activity');
    expect(within(section).getByText('Only you can see this')).toBeTruthy();
    const link = within(section).getByRole('link', { name: /Mishari invited you to Workshop/ });
    expect(link.getAttribute('href')).toBe('/admin/invitations/i1');
    expect(within(section).getAllByText('5 hours ago')).toHaveLength(2);
    expect(within(section).queryByRole('link', { name: /You starred HQ Lobby/ })).toBeNull();
  });

  it('on You shows the latest three, with View all for the rest; the full page shows every one', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    answer({ events: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, kind: 'star', text: `You starred room ${id}`, at, href: null })) });
    const onYou = render(<ActivitySection limit={3} />);
    const section = await screen.findByTestId('activity');
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    expect(within(section).getByText('You starred room a')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/admin/you/activity');
    onYou.unmount();

    render(<ActivitySection bare />);
    const full = await screen.findByTestId('activity');
    expect(within(full).getAllByRole('listitem')).toHaveLength(5);
    expect(within(full).queryByRole('link', { name: 'View all' })).toBeNull();
    expect(within(full).queryByRole('heading')).toBeNull();
  });

  it('has no View all when every activity already shows', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    answer({ events: ['a', 'b'].map((id) => ({ id, kind: 'star', text: `You starred room ${id}`, at, href: null })) });
    render(<ActivitySection limit={3} />);
    const section = await screen.findByTestId('activity');
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(within(section).queryByRole('link', { name: 'View all' })).toBeNull();
  });

  it('is left out when nothing happened yet, or it cannot be read', async () => {
    answer({ events: [] });
    const { container, unmount } = render(<ActivitySection />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/activity'));
    expect(container.textContent).toBe('');
    unmount();
    answer({}, false);
    const second = render(<ActivitySection />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe('');
  });
});
