/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HerePanel from '@/app/admin/components/here-panel';
import RecentlyVisited from '@/app/admin/components/recently-visited';
import { WorkAdventureContext } from '@/app/admin/workadventure-context';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import { localHourFromUtc, localPeakHour } from '@/lib/analytics-peak';
import { isSummariesUrl, summariesBody } from '../helpers/summaries';

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

const analytics: Record<string, unknown> = {
  'r-hq': {
    totalAccesses: 1204,
    recentActivity: [],
    peakTimes: [{ hour: 16, count: 40 }],
    lastVisitedByUser: { accessedAt: minutesAgo(12) },
    lastVisitedOverall: { accessedAt: minutesAgo(3), userName: 'Imagine' },
  },
  'r-hub': {
    totalAccesses: 233,
    recentActivity: [],
    peakTimes: [],
    lastVisitedByUser: { accessedAt: minutesAgo(40), userId: 'u1' },
    lastVisitedOverall: { accessedAt: minutesAgo(40), userId: 'u1' },
  },
};

const responses: Record<string, unknown> = {
  '/api/admin/rooms/from-play-uri': hq,
  '/api/admin/rooms/previous': { room: hub },
  '/api/admin/rooms/recent': {
    rooms: [
      { roomId: 'r-hq', roomName: 'Headquarters', roomSlug: 'headquarters', roomDescription: null, roomFavorites: 9, worldName: 'Office', worldSlug: 'office', universeName: 'BAWES', universeSlug: 'bawes', accessedAt: minutesAgo(12) },
      { roomId: 'r-hub', roomName: 'Creative Hub', roomSlug: 'hub', roomDescription: null, roomFavorites: 3, worldName: 'Office', worldSlug: 'office', universeName: 'BAWES', universeSlug: 'bawes', accessedAt: minutesAgo(40) },
    ],
  },
};

/** Paths that answer 500 until cleared: a server failure, not a missing room. */
const failing = new Set<string>();

jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: async (url: string) => {
    const path = url.split('?')[0];
    if (failing.has(path)) return { ok: false, status: 500, json: async () => ({}) } as Response;
    const body = isSummariesUrl(url) ? summariesBody(url, (id) => analytics[id]) : responses[path];
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

  it("takes Peak from all visits (the server's hour buckets), on the viewer's clock", () => {
    // 16:00 UTC is the busiest bucket; the card shows that hour in local time, whatever one page of visits says.
    const expected = localHourFromUtc(16);
    expect(localPeakHour([{ hour: 16, count: 40 }, { hour: 9, count: 2 }])).toBe(expected);
    expect(localPeakHour([])).toBeNull();
  });
});

describe('Where you are, when it fails', () => {
  afterEach(() => failing.clear());

  it('Try again clears the failure at once, then shows the room', async () => {
    failing.add('/api/admin/rooms/from-play-uri');
    render(inGame(<HerePanel />));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText('No room information available')).toBeTruthy();
    failing.clear();
    fireEvent.click(retry);
    expect(screen.queryByText('No room information available')).toBeNull();
    expect(await screen.findByText('Headquarters')).toBeTruthy();
  });
});

describe('Where you are: the start map and unlisted rooms', () => {
  const resolved = responses['/api/admin/rooms/from-play-uri'];
  afterEach(() => {
    responses['/api/admin/rooms/from-play-uri'] = resolved;
  });
  const withStartRoom = (startRoom: string | null, children: React.ReactNode) => (
    <AdminBootstrapProvider
      value={{ version: 1, user: { id: 'u', uuid: 'u', name: 'Me', email: null, tags: [], isSuperAdmin: false }, stats: { universes: 0, worlds: 0, rooms: 0, users: 0 }, startRoom } as AdminBootstrap}
    >
      {children}
    </AdminBootstrapProvider>
  );

  it('calls the configured START_ROOM_URL the start map', async () => {
    render(withStartRoom('@/bawes/office/headquarters', inGame(<HerePanel />)));
    expect(await screen.findByText('The start map')).toBeTruthy();
    expect(screen.queryByTestId('room-card-here')).toBeNull();
  });

  it('shows the room itself when the start room is elsewhere', async () => {
    render(withStartRoom('@/default/default/default', inGame(<HerePanel />)));
    expect(await screen.findByTestId('room-card-here')).toBeTruthy();
    expect(screen.queryByText('The start map')).toBeNull();
  });

  it('says a room isn’t listed, without naming its owner', async () => {
    responses['/api/admin/rooms/from-play-uri'] = { ...hq, unlisted: true };
    render(withStartRoom('@/mine/office/lobby', inGame(<HerePanel />)));
    const notice = (await screen.findByText("A room that isn't listed")).closest('[role="status"]') as HTMLElement;
    expect(notice.textContent).toContain("This room isn't listed anywhere in Orbit.");
    expect(notice.textContent).toContain('You are here');
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/admin/space');
    expect(notice.textContent).not.toMatch(/System/);
    expect(screen.queryByTestId('room-card-here')).toBeNull();
  });
});
