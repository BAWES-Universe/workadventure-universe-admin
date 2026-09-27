/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SpacesPage from '@/app/admin/spaces/page';
import PlacesRedirect from '@/app/admin/places/page';
import YouPage from '@/app/admin/you/page';
import YourPlaces from '@/app/admin/components/your-places';
import { ThemeChoice } from '@/app/admin/components/shell/theme-choice';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';

let mockQuery = '';
const mockFetch = jest.fn();
const mockSetTheme = jest.fn();
const mockRedirect = jest.fn();
const bootstrap: AdminBootstrap = {
  version: 1,
  user: { id: 'owner', uuid: 'owner-uuid', name: 'Khalid', email: 'k@example.test', tags: [], isSuperAdmin: true },
  stats: { universes: 40, worlds: 100, rooms: 300, users: 500 },
  mine: { universes: 1, worlds: 2, stars: 3, invitations: 1 },
};

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockQuery),
  redirect: (href: string) => mockRedirect(href),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => mockFetch(...args), clearClientSession: jest.fn() }));
jest.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', setTheme: mockSetTheme }) }));

const reply = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
function defaults(url: string) {
  if (url.startsWith('/api/admin/universes?')) return reply({ universes: [] });
  if (url === '/api/memberships/my') return reply({ memberships: [] });
  return reply({ rooms: [] });
}
function show(content: React.ReactNode, value = bootstrap) {
  return render(<AdminBootstrapProvider value={value}>{content}</AdminBootstrapProvider>);
}

beforeEach(() => {
  mockQuery = '';
  mockFetch.mockReset().mockImplementation(defaults);
  mockSetTheme.mockReset();
  mockRedirect.mockReset();
});

it('treats a failed universe request as an error, preserves successful sections, and retries just that collection', async () => {
  let failed = true;
  mockFetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/universes?') && failed) return reply({ error: 'Unavailable' }, 503);
    return defaults(url);
  });
  show(<SpacesPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load your universes.');
  expect(screen.queryByText('Every universe starts with an idea.')).not.toBeInTheDocument();
  expect(await screen.findByText('Some rooms feel like home.')).toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Every universe starts with an idea.')).toBeInTheDocument();
  expect(mockFetch.mock.calls.filter(([url]) => url === '/api/memberships/my')).toHaveLength(1);
  expect(mockFetch.mock.calls.filter(([url]) => url.startsWith('/api/admin/universes?'))).toHaveLength(2);
});

it('rejects malformed nested items instead of crashing or presenting a new account', async () => {
  mockFetch.mockImplementation((url: string) => url === '/api/memberships/my' ? reply({ memberships: [{ id: 'm1', tags: [], world: null }] }) : defaults(url));
  show(<SpacesPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load your memberships.');
  expect(screen.queryByText('Find your people.')).not.toBeInTheDocument();
});

it('uses owned-universe scope and keeps the actual universe, world, star and invitation destinations', async () => {
  mockFetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/universes?')) return reply({ universes: [{ id: 'universe-1', name: 'Butterfly', isPublic: false, _count: { worlds: 2, rooms: 5 } }] });
    if (url === '/api/memberships/my') return reply({ memberships: [{ id: 'm1', tags: ['member'], world: { id: 'world-1', name: 'StudentHub', universe: { name: 'Butterfly' } } }] });
    return reply({ rooms: [{ id: 'room-1', name: 'The café', world: { name: 'StudentHub', universe: { name: 'Butterfly' } } }] });
  });
  show(<SpacesPage />);
  const ownedLink = await screen.findByRole('link', { name: /Your universe Private Butterfly/ });
  expect(ownedLink).toHaveAttribute('href', '/admin/universes/universe-1');
  expect(ownedLink).toHaveTextContent('2 worlds · 5 rooms');
  expect(screen.getByRole('link', { name: /StudentHub Butterfly · member/ })).toHaveAttribute('href', '/admin/worlds/world-1');
  expect(screen.getByRole('link', { name: /The café StudentHub/ })).toHaveAttribute('href', '/admin/rooms/room-1');
  expect(screen.getByRole('link', { name: /1 invitation is waiting/ })).toHaveAttribute('href', '/admin/memberships');
  expect(mockFetch).toHaveBeenCalledWith('/api/admin/universes?scope=my&limit=4', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('keeps Explore as keyboard-accessible navigation and does not mislabel platform totals as public discovery counts', () => {
  mockQuery = 'tab=explore';
  show(<SpacesPage />);
  const nav = screen.getByRole('navigation', { name: 'Spaces views' });
  expect(within(nav).getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
  expect(within(nav).getByRole('link', { name: 'Mine' })).toHaveAttribute('href', '/admin/spaces');
  for (const [name, href] of [['Universes', '/admin/discover/universes'], ['Worlds', '/admin/discover/worlds'], ['Rooms', '/admin/discover/rooms'], ['People', '/admin/users']]) {
    expect(screen.getByRole('link', { name: new RegExp(name) })).toHaveAttribute('href', href);
  }
  expect(screen.getByRole('link', { name: 'Browse room templates' })).toHaveAttribute('href', '/admin/templates');
  expect(screen.queryByText('500')).not.toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('aborts every pending collection when leaving the page', async () => {
  mockFetch.mockImplementation(() => new Promise(() => {}));
  const view = show(<SpacesPage />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
  const signals = mockFetch.mock.calls.map(([, options]) => options.signal as AbortSignal);
  view.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it('preserves old Mine and Explore bookmarks through canonical redirects', async () => {
  await PlacesRedirect({ searchParams: Promise.resolve({ tab: 'explore' }) });
  expect(mockRedirect).toHaveBeenLastCalledWith('/admin/spaces?tab=explore');
  await PlacesRedirect({ searchParams: Promise.resolve({}) });
  expect(mockRedirect).toHaveBeenLastCalledWith('/admin/spaces');
});

it('does not invent zero counts or a newcomer state when optional personal counts are unavailable', () => {
  show(<YourPlaces />, { ...bootstrap, mine: undefined });
  expect(screen.queryByTestId('your-places-empty')).not.toBeInTheDocument();
  expect(screen.queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'All spaces' })).toHaveAttribute('href', '/admin/spaces');
});

it('preserves profile, memberships, stars, administrator identity and signout on You', () => {
  show(<YouPage />);
  expect(screen.getByRole('heading', { name: 'Khalid' })).toBeInTheDocument();
  expect(screen.getByText('Super admin')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'My Visit Card' })).toHaveAttribute('href', '/admin/profile');
  expect(screen.getByRole('link', { name: /My Memberships/ })).toHaveAttribute('href', '/admin/memberships');
  expect(screen.getByRole('link', { name: /My Stars/ })).toHaveAttribute('href', '/admin/stars');
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
});

it('gives theme radios one tab stop, arrow wrap, and Home/End navigation', () => {
  render(<ThemeChoice />);
  const light = screen.getByRole('radio', { name: 'Light' });
  const dark = screen.getByRole('radio', { name: 'Dark' });
  const auto = screen.getByRole('radio', { name: 'Auto' });
  expect(dark).toHaveAttribute('tabindex', '0');
  expect(light).toHaveAttribute('tabindex', '-1');
  expect(auto).toHaveAttribute('tabindex', '-1');
  fireEvent.keyDown(dark, { key: 'ArrowRight' });
  expect(mockSetTheme).toHaveBeenLastCalledWith('system');
  expect(auto).toHaveFocus();
  fireEvent.keyDown(auto, { key: 'ArrowRight' });
  expect(mockSetTheme).toHaveBeenLastCalledWith('light');
  expect(light).toHaveFocus();
  fireEvent.keyDown(light, { key: 'End' });
  expect(auto).toHaveFocus();
  fireEvent.keyDown(auto, { key: 'Home' });
  expect(light).toHaveFocus();
});
