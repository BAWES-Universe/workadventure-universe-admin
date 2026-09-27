/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UsersPage from '@/app/admin/users/page';
import DiscoverWorldsPage from '@/app/admin/discover/worlds/page';
import { clearSummaryCache } from '@/app/admin/hooks/use-room-analytics';
import { summariesBody } from '../helpers/summaries';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const push = jest.fn();
let urlParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => '/admin/test',
  useSearchParams: () => urlParams,
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

type Deferred = { url: string; resolve: (body: unknown) => void };

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

/** Every list request waits until the test answers it, so the test decides the order answers arrive in. */
function holdLists(prefix: string, other: (url: string) => unknown = () => ({})) {
  const held: Deferred[] = [];
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/auth/me') return Promise.resolve(json({ user: { id: 'me' } }));
    if (url.startsWith(prefix)) {
      return new Promise((resolve) => held.push({ url, resolve: (body) => resolve(json(body)) }));
    }
    return Promise.resolve(json(other(url)));
  });
  return held;
}

const person = (id: string, name: string) => ({
  id,
  uuid: id,
  name,
  isGuest: false,
  createdAt: '2026-01-01T00:00:00Z',
  _count: { ownedUniverses: 0, worldMemberships: 0 },
});

beforeEach(() => {
  urlParams = new URLSearchParams();
  fetchMock.mockReset();
  push.mockReset();
  clearSummaryCache();
});

describe('A search from the address', () => {
  it('opens People on the search Space was showing, in one request', async () => {
    urlParams = new URLSearchParams('q=sara');
    const held = holdLists('/api/admin/users');
    render(<UsersPage />);
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0].url).toContain('search=sara');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('sara');
  });
});

describe('People search', () => {
  it('keeps the newest search’s results when an older answer arrives late', async () => {
    const held = holdLists('/api/admin/users');
    render(<UsersPage />);
    await waitFor(() => expect(held).toHaveLength(1));
    act(() => held[0].resolve({ users: [person('1', 'Everyone')], pagination: { total: 1, totalPages: 1 } }));
    await screen.findByText('Everyone');

    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'al' } });
    await waitFor(() => expect(held).toHaveLength(2), { timeout: 2000 });
    expect(held[1].url).toContain('search=al');
    expect(held[1].url).toContain('page=1');

    // Typing goes on while "al" is still running: it is not skipped.
    fireEvent.change(box, { target: { value: 'alice' } });
    await waitFor(() => expect(held).toHaveLength(3), { timeout: 2000 });
    expect(held[2].url).toContain('search=alice');

    // B ("alice") answers first, then A ("al") late: B stays.
    await act(async () => held[2].resolve({ users: [person('2', 'Alice B')], pagination: { total: 1, totalPages: 1 } }));
    await screen.findByText('Alice B');
    await act(async () => held[1].resolve({ users: [person('3', 'Stale Al')], pagination: { total: 1, totalPages: 1 } }));
    expect(screen.queryByText('Stale Al')).toBeNull();
    expect(screen.getByText('Alice B')).toBeTruthy();
  });

  it('waits for typing to pause: one request for a burst of keys', async () => {
    const held = holdLists('/api/admin/users');
    render(<UsersPage />);
    await waitFor(() => expect(held).toHaveLength(1));
    const box = screen.getByRole('searchbox');
    for (const value of ['b', 'bo', 'bob']) fireEvent.change(box, { target: { value } });
    await waitFor(() => expect(held).toHaveLength(2), { timeout: 2000 });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(held).toHaveLength(2);
    expect(held[1].url).toContain('search=bob');
  });

  it('starts a new search on page 1', async () => {
    const held = holdLists('/api/admin/users');
    render(<UsersPage />);
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () =>
      held[0].resolve({ users: [person('1', 'Page one')], pagination: { total: 120, totalPages: 3 } }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(held).toHaveLength(2));
    expect(held[1].url).toContain('page=2');
    await act(async () => held[1].resolve({ users: [person('2', 'Page two')], pagination: { total: 120, totalPages: 3 } }));

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zed' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(held).toHaveLength(3));
    expect(held[2].url).toContain('page=1');
    expect(held[2].url).toContain('search=zed');
  });
});

describe('Discover search', () => {
  const world = (id: string, name: string) => ({
    id,
    slug: id,
    name,
    description: null,
    isPublic: true,
    featured: false,
    thumbnailUrl: null,
    universe: { id: 'u', name: 'Uni', slug: 'u' },
    _count: { rooms: 1, members: 2 },
  });

  it('keeps B’s results when A answers after B, and shows accesses and the peak', async () => {
    const held = holdLists('/api/admin/worlds', (url) => summariesBody(url, () => ({
      totalAccesses: 1284,
      peakTimes: [{ hour: 16, count: 40 }],
      lastVisitedByUser: null,
      lastVisitedOverall: { accessedAt: '2026-09-01T10:00:00Z' },
      youWereLast: false,
    })));
    render(<DiscoverWorldsPage />);
    await waitFor(() => expect(held).toHaveLength(1));
    const box = screen.getByRole('searchbox');

    fireEvent.change(box, { target: { value: 'moon' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(held).toHaveLength(2));
    fireEvent.change(box, { target: { value: 'mars' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(held).toHaveLength(3));

    await act(async () => held[2].resolve({ worlds: [world('b', 'Mars base')], pagination: { total: 1, totalPages: 1 } }));
    await screen.findByText('Mars base');
    await act(async () => held[1].resolve({ worlds: [world('a', 'Moon base')], pagination: { total: 1, totalPages: 1 } }));
    await act(async () => held[0].resolve({ worlds: [world('z', 'Everything')], pagination: { total: 1, totalPages: 1 } }));
    expect(screen.queryByText('Moon base')).toBeNull();
    expect(screen.queryByText('Everything')).toBeNull();
    expect(screen.getByText('Mars base')).toBeTruthy();

    const at = new Date();
    at.setUTCHours(16, 0, 0, 0);
    const hour = at.getHours();
    const label = `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
    await waitFor(() => expect(document.body.textContent).toContain(`1,284 accesses · Peak ${label}`));
    expect(document.body.textContent).not.toMatch(/UTC|visits|busiest/);
    expect(document.body.textContent).not.toContain('You were the last visitor');
  });
});
