/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import HerePanel from '@/app/admin/components/here-panel';
import RecentlyVisited from '@/app/admin/components/recently-visited';
import RoomSignalCard from '@/app/admin/components/room-signal-card';
import { roomSignalFromAnalytics, wasLastVisitorYou, type SignalRoom } from '@/app/admin/components/room-signal-data';
import { WorkAdventureContext, type WorkAdventureContextValue } from '@/app/admin/workadventure-context';

const mockFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (url: string, options?: RequestInit) => mockFetch(url, options) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
const current: SignalRoom = { id: 'current', name: 'Moon Garden', slug: 'garden', description: 'A gathering place under the stars.', _count: { favorites: 7 }, world: { id: 'w', name: 'Lunar', slug: 'lunar', universe: { id: 'u', name: 'Universe', slug: 'universe' } } };
const previous: SignalRoom = { ...current, id: 'previous', name: 'Quiet Library', slug: 'library', description: 'A place to think.', _count: { favorites: 3 }, accessedAt: '2026-09-27T05:00:00Z' };
const analytics = { totalAccesses: 143, recentActivity: [{ accessedAt: '2026-09-27T06:00:00Z' }], lastVisitedByUser: { accessedAt: '2026-09-27T06:00:00Z', userId: 'me' }, lastVisitedOverall: { accessedAt: '2026-09-27T06:00:00Z', userId: 'me' } };
const navigateToRoom = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
function context(room = 'garden'): WorkAdventureContextValue {
  return { wa: { onInit: () => Promise.resolve(), room: { id: `https://play.example/@/universe/lunar/${room}` } } as never, isReady: true, isLoading: false, error: null, navigateToRoom };
}
function wrap(children: React.ReactNode, value = context()) { return <WorkAdventureContext.Provider value={value}>{children}</WorkAdventureContext.Provider>; }

beforeEach(() => { mockFetch.mockReset(); navigateToRoom.mockReset(); navigateToRoom.mockResolvedValue(undefined); });

it('restores current and previous room descriptions, stars, activity, visitor history and return navigation', async () => {
  mockFetch.mockImplementation(async (url) => response(url.includes('from-play-uri') ? current : url.includes('/previous?') ? { room: previous } : analytics));
  render(wrap(<HerePanel />));
  const here = await screen.findByTestId('room-signal-current');
  const before = await screen.findByTestId('room-signal-previous');
  expect(within(here).getByText(current.description!)).toBeTruthy();
  expect(within(here).getByLabelText('7 stars')).toBeTruthy();
  await within(here).findByText('143');
  expect(within(here).getByText('Last visited by you')).toBeTruthy();
  expect(within(here).getByText('Peak hour')).toBeTruthy();
  expect(within(here).getByText('You')).toBeTruthy();
  expect(within(before).getByText(previous.description!)).toBeTruthy();
  expect(within(before).getByLabelText('3 stars')).toBeTruthy();
  await within(before).findByText('143');
  const disclosure = before.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(within(before).getByText('Room activity'));
  expect(disclosure.open).toBe(true);
  expect(within(before).getByRole('link', { name: 'Explore Quiet Library' })).toHaveAttribute('href', '/admin/rooms/previous');
  const visit = within(before).getByRole('button', { name: 'Visit Quiet Library' });
  expect(visit.closest('a')).toBeNull();
  fireEvent.click(visit);
  await waitFor(() => expect(navigateToRoom).toHaveBeenCalledWith('/@/universe/lunar/library'));
});

it('aborts stale room activity and never paints the old response into a new room', async () => {
  const old = deferred();
  mockFetch.mockImplementation((url) => url.endsWith('/current') ? old.promise : Promise.resolve(response({ ...analytics, totalAccesses: 9 })));
  const value = context();
  const view = render(wrap(<RoomSignalCard room={current} />, value));
  const oldSignal = mockFetch.mock.calls[0][1]?.signal;
  view.rerender(wrap(<RoomSignalCard room={previous} />, value));
  await screen.findByText('9');
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => old.resolve(response(analytics)));
  expect(screen.queryByText('143')).toBeNull();
  expect(screen.getByText('9')).toBeTruthy();
});

it('preserves the previous stop on the shared start map without presenting that map as an owned room', async () => {
  const value = context();
  value.wa = { onInit: () => Promise.resolve(), room: { id: 'https://play.example/@/default/default/default' } } as never;
  mockFetch.mockImplementation(async (url) => response(url.includes('from-play-uri') ? { ...current, id: 'start', name: 'Default room' } : url.includes('/previous?') ? { room: previous } : analytics));
  render(wrap(<HerePanel />, value));
  expect(await screen.findByRole('link', { name: 'Explore universes' })).toHaveAttribute('href', '/admin/spaces');
  await screen.findByTestId('room-signal-previous');
  expect(screen.queryByTestId('room-signal-start')).toBeNull();
  expect(screen.queryByText('Default room')).toBeNull();
  expect(mockFetch.mock.calls.some(([url]) => url.includes('currentRoomId=start'))).toBe(true);
});

it('aborts the old previous-location request when current room changes', async () => {
  const old = deferred();
  mockFetch.mockImplementation(async (url) => {
    if (url.includes('from-play-uri')) return response(url.includes('library') ? previous : current);
    if (url.includes('currentRoomId=current')) return old.promise;
    if (url.includes('currentRoomId=previous')) return response({ room: null });
    return response(analytics);
  });
  const view = render(wrap(<HerePanel />));
  await screen.findByTestId('room-signal-current');
  await waitFor(() => expect(mockFetch.mock.calls.some(([url]) => url.includes('currentRoomId=current'))).toBe(true));
  const oldSignal = mockFetch.mock.calls.find(([url]) => url.includes('currentRoomId=current'))![1]?.signal;
  view.rerender(wrap(<HerePanel />, context('library')));
  await screen.findByTestId('room-signal-previous');
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => old.resolve(response({ room: { ...current, id: 'stale', name: 'Stale room' } })));
  expect(screen.queryByText('Stale room')).toBeNull();
});

it('reports optional activity failure truthfully and retries while preserving navigation and stars', async () => {
  mockFetch.mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response(analytics));
  render(wrap(<RoomSignalCard room={current} />));
  await screen.findByText('Activity is unavailable.');
  expect(screen.queryByText(/Reading room activity/)).toBeNull();
  expect(screen.getByLabelText('7 stars')).toBeTruthy();
  fireEvent.click(screen.getByText('Room activity'));
  expect(screen.getByRole('link', { name: 'Explore Moon Garden' })).toHaveAttribute('href', '/admin/rooms/current');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('143');
});

it('keeps recent room enrichment and an honest failure state distinct from an empty visit trail', async () => {
  mockFetch.mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response({ rooms: [] }));
  render(wrap(<RecentlyVisited />));
  await screen.findByText("We couldn't load your recent rooms.");
  expect(screen.queryByText(/Your visits will leave a trail/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText(/Your visits will leave a trail/);
  expect(screen.getByRole('link', { name: 'Explore universes' })).toHaveAttribute('href', '/admin/spaces');
});

it('uses recent endpoint descriptions and stars without extra detail requests', async () => {
  const recent = { roomId: 'current', roomName: current.name, roomSlug: current.slug, roomDescription: current.description, roomFavorites: 7, worldId: 'w', worldName: 'Lunar', worldSlug: 'lunar', universeId: 'u', universeName: 'Universe', universeSlug: 'universe', accessedAt: '2026-09-27T06:00:00Z' };
  mockFetch.mockImplementation(async (url) => response(url.includes('/recent?') ? { rooms: [recent] } : analytics));
  render(wrap(<RecentlyVisited />));
  await screen.findByText(current.description!);
  expect(screen.getByLabelText('7 stars')).toBeTruthy();
  await screen.findByText('143');
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('reports navigation failure inline', async () => {
  mockFetch.mockResolvedValue(response(analytics));
  navigateToRoom.mockRejectedValue(new Error('Game unavailable'));
  render(wrap(<RoomSignalCard room={previous} variant="previous" />));
  fireEvent.click(screen.getByRole('button', { name: 'Visit Quiet Library' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open this room");
});

it('does not claim a redacted visitor is you just because the visit timestamp matches', () => {
  const redacted = roomSignalFromAnalytics({ ...analytics, lastVisitedByUser: { accessedAt: analytics.lastVisitedByUser.accessedAt }, lastVisitedOverall: { accessedAt: analytics.lastVisitedOverall.accessedAt } });
  expect(wasLastVisitorYou(redacted)).toBe(false);
  expect(wasLastVisitorYou(roomSignalFromAnalytics(analytics))).toBe(true);
});

it('labels UTC fallback correctly and does not fabricate missing or invalid access counts', () => {
  const signal = roomSignalFromAnalytics({ peakTimes: [{ hour: 18, count: 6 }], recentActivity: [{ accessedAt: 'invalid' }] });
  expect(signal.peakHour).toBe(18);
  expect(signal.peakZone).toBe('UTC');
  expect(signal.totalAccesses).toBeNull();
  expect(roomSignalFromAnalytics({ totalAccesses: 0 }).totalAccesses).toBe(0);
});
