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
