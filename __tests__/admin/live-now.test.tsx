/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LiveNow, LiveNowView } from '@/app/admin/components/live/live-now';
import { HideLocationSetting } from '@/app/admin/components/live/hide-location-setting';
import { WorkAdventureContext } from '@/app/admin/workadventure-context';
import type { LivePlace, LiveView } from '@/lib/live-presence';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const BAWES = { id: 'un-bawes', name: 'BAWES' };
const FUN = { id: 'un-fun', name: 'Fun Zone' };
const person = (name: string, extra: Partial<LivePlace['people'][number]> = {}) => ({
  uuid: name,
  name,
  status: 'online' as const,
  woka: [],
  you: false,
  ...extra,
});
const place = (
  roomId: string,
  name: string,
  universe: { id: string; name: string },
  people: LivePlace['people'],
  extra: Partial<LivePlace> = {},
): LivePlace => ({
  roomId,
  name,
  world: { id: `w-${roomId}`, name: 'HQ' },
  universe,
  playPath: `/@/x/hq/${roomId}`,
  count: people.length,
  guests: 0,
  bots: 0,
  people,
  here: false,
  ...extra,
});

const hall = place('hall', 'Main Hall', BAWES, [person('Me', { you: true }), person('Dana')], { here: true, count: 4, bots: 2 });
const arcade = place('arcade', 'Arcade', FUN, [person('Omar', { status: 'busy' })]);
const at = (p: LivePlace) => ({ roomId: p.roomId, name: p.name, world: p.world, universe: p.universe, playPath: p.playPath });
const view: LiveView = {
  available: true,
  generatedAt: 1,
  places: [hall, arcade],
  people: [
    { ...person('Dana'), place: at(hall) },
    { ...person('Omar', { status: 'busy' }), place: at(arcade) },
  ],
};

beforeEach(() => fetchMock.mockReset());

describe('Live now', () => {
  it('shows the places with people in them, who is where, and the bots', () => {
    render(<LiveNowView view={view} layout="space" />);
    const cards = screen.getAllByTestId('live-place');
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual(['Main Hall', 'Arcade']);
    expect(within(cards[0]).getByText('You’re here')).toBeTruthy();
    expect(within(cards[0]).getByText('2 bots')).toBeTruthy();
    // You're in the hall: Dana is "Here", Omar is a Go.
    const rows = screen.getAllByTestId('live-person');
    expect(within(rows[0]).getByText('Here')).toBeTruthy();
    expect(within(rows[1]).getByText('Busy')).toBeTruthy();
    expect(within(rows[1]).getByRole('link', { name: 'Go: Arcade' }).getAttribute('href')).toBe('/admin/rooms/arcade');
  });

  it('filters by universe, and Friends waits for friends', () => {
    render(<LiveNowView view={view} layout="space" />);
    fireEvent.click(screen.getByRole('button', { name: 'Fun Zone' }));
    expect(screen.getAllByTestId('live-place').map((card) => within(card).getByRole('heading').textContent)).toEqual(['Arcade']);
    expect(screen.getAllByTestId('live-person')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Friends' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts Orbit home on the universe you are in', () => {
    render(<LiveNowView view={view} layout="home-column" />);
    expect(screen.getByRole('button', { name: 'BAWES' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByTestId('live-place')).toHaveLength(1);
  });

  it('goes straight to the room inside the game', () => {
    const navigateToRoom = jest.fn(() => Promise.resolve());
    render(
      <WorkAdventureContext.Provider value={{ wa: null, isReady: true, isLoading: false, error: null, navigateToRoom }}>
        <LiveNowView view={view} layout="space" />
      </WorkAdventureContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Visit: Arcade' }));
    expect(navigateToRoom).toHaveBeenCalledWith('/@/x/hq/arcade');
  });

  it('says so when nobody is around, and stays out of Orbit home', () => {
    const empty: LiveView = { available: true, generatedAt: 1, places: [], people: [] };
    const { container, unmount } = render(<LiveNowView view={empty} layout="home-inline" />);
    expect(container.textContent).toBe('');
    unmount();
    render(<LiveNowView view={empty} layout="space" />);
    expect(screen.getByText(/Nobody is in a room you can enter right now/)).toBeTruthy();
  });

  it('is left out entirely while the game can’t say', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ available: false }) });
    const { container } = render(<LiveNow layout="space" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/live'));
    expect(container.textContent).toBe('');
  });
});

describe('Hide where I am', () => {
  it('reads and saves the switch on your account', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve({ ok: true, json: async () => (init?.method === 'PUT' ? {} : { preferences: {} }) }),
    );
    render(<HideLocationSetting />);
    const toggle = screen.getByTestId('hide-location');
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', {
        method: 'PUT',
        body: JSON.stringify({ key: 'people.hideLocation', value: true }),
      }),
    );
    expect(screen.getByText(/Nobody sees which room you’re in/)).toBeTruthy();
  });
});
