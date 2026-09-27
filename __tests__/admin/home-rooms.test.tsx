/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import HerePanel from '@/app/admin/components/here-panel';
import RecentlyVisited from '@/app/admin/components/recently-visited';
import { WorkAdventureContext } from '@/app/admin/workadventure-context';
import { peakHourOf } from '@/app/admin/hooks/use-room-analytics';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const hq = {
  id: 'r-hq',
  slug: 'headquarters',
  name: 'Headquarters',
  description: 'Where the team meets',
  world: { id: 'w-1', name: 'Office', slug: 'office', universe: { id: 'u-1', name: 'BAWES', slug: 'bawes' } },
  _count: { favorites: 9 },
};
const hub = { ...hq, id: 'r-hub', slug: 'hub', name: 'Creative Hub', description: null, _count: { favorites: 3 }, accessedAt: minutesAgo(40) };

const responses: Record<string, unknown> = {
  '/api/admin/rooms/from-play-uri': hq,
  '/api/admin/rooms/previous': { room: hub },
  '/api/admin/analytics/rooms/r-hq': {
    totalAccesses: 1204,
    recentActivity: [],
    peakTimes: [{ hour: 16, count: 40 }],
    lastVisitedByUser: { accessedAt: minutesAgo(12) },
    lastVisitedOverall: { accessedAt: minutesAgo(3), userName: 'Imagine' },
  },
  '/api/admin/analytics/rooms/r-hub': {
    totalAccesses: 233,
    recentActivity: [],
    peakTimes: [],
    lastVisitedByUser: { accessedAt: minutesAgo(40), userId: 'u1' },
    lastVisitedOverall: { accessedAt: minutesAgo(40), userId: 'u1' },
  },
  '/api/admin/rooms/recent': {
    rooms: [
      { roomId: 'r-hq', roomName: 'Headquarters', roomSlug: 'headquarters', roomDescription: null, roomFavorites: 9, worldName: 'Office', worldSlug: 'office', universeName: 'BAWES', universeSlug: 'bawes', accessedAt: minutesAgo(12) },
      { roomId: 'r-hub', roomName: 'Creative Hub', roomSlug: 'hub', roomDescription: null, roomFavorites: 3, worldName: 'Office', worldSlug: 'office', universeName: 'BAWES', universeSlug: 'bawes', accessedAt: minutesAgo(40) },
    ],
  },
};

jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: async (url: string) => {
    const path = url.split('?')[0];
    const body = responses[path];
    return { ok: body !== undefined, status: body ? 200 : 404, json: async () => body } as Response;
  },
}));

function inGame(children: React.ReactNode, ready = true) {
  return (
    <WorkAdventureContext.Provider
      value={{
        wa: ready ? ({ onInit: async () => undefined, room: { id: 'https://play.example.com/@/bawes/office/headquarters' } } as never) : null,
        isReady: ready,
        isLoading: false,
        error: null,
        navigateToRoom: jest.fn(),
      }}
    >
      {children}
    </WorkAdventureContext.Provider>
  );
}

describe('Home rooms keep their numbers', () => {
  it('shows where you are and where you were before, with stars, visits, peak and the latest visitor', async () => {
    const onShown = jest.fn();
    render(inGame(<HerePanel onShown={onShown} />));
    const here = await screen.findByTestId('room-card-here');
    await waitFor(() => expect(here.textContent).toContain('1,204'));
    expect(here.textContent).toContain('Headquarters');
    expect(here.textContent).toMatch(/BAWES\s*\/\s*Office/);
    expect(here.textContent).toContain('Where the team meets');
    expect(here.textContent).toContain('9');
    expect(here.textContent).toMatch(/Last visited by you\s*12 minutes ago/);
    expect(here.textContent).toMatch(/Most recent visitor\s*3 minutes ago/);
    // Visitors aren't named on the card, and the peak hour carries no time-zone label.
    expect(here.textContent).not.toContain('Imagine');
    expect(here.textContent).not.toContain('UTC');
    // No Visit on the room you're already in.
    expect(here.querySelector('button')).toBeNull();

    const before = await screen.findByTestId('room-card-previous');
    await waitFor(() => expect(before.textContent).toContain('233'));
    expect(before.textContent).toContain('Creative Hub');
    expect(before.textContent).toContain('You were the last visitor');
    // No small Visit button: the whole card opens the room's page, which has its details and Visit.
    expect(before.querySelector('button')).toBeNull();
    expect(before.querySelector('a')?.getAttribute('href')).toBe('/admin/rooms/r-hub');
    expect(onShown).toHaveBeenLastCalledWith(['r-hq', 'r-hub']);
  });

  it('explains itself outside the game', () => {
    render(inGame(<HerePanel />, false));
    expect(screen.getByRole('status').textContent).toMatch(/inside Universe/);
  });

  it('leaves the rooms already shown under Where you are out of Recently visited', async () => {
    render(inGame(<RecentlyVisited excludeRoomIds={['r-hq']} />));
    const cards = await screen.findAllByTestId('room-card-trail');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Creative Hub');
  });

  it('finds the busiest hour in local time, falling back to the server', () => {
    const at = (hour: number) => {
      const date = new Date();
      date.setHours(hour, 5, 0, 0);
      return { accessedAt: date.toISOString() };
    };
    expect(peakHourOf({ recentActivity: [at(9), at(14), at(14)] })).toEqual({ hour: 14, zone: 'local' });
    expect(peakHourOf({ recentActivity: [], peakTimes: [{ hour: 7, count: 3 }] })).toEqual({ hour: 7, zone: 'UTC' });
    expect(peakHourOf({})).toEqual({ hour: null, zone: 'UTC' });
  });
});
