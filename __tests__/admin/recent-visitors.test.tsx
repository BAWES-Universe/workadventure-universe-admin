/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RecentVisitors from '@/app/admin/components/recent-visitors';

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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const visitors = [
  { userId: 'omar', name: 'Omar', woka: [], at: ago(1), room: { id: 'r1', name: 'HQ Lobby' } },
  { userId: 'sara', name: 'Sara', woka: [], at: ago(4), room: { id: 'r1', name: 'HQ Lobby' } },
];

function serve(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((path: string) => {
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate) && (candidate.endsWith('/passport') ? path.endsWith('/passport') : !path.endsWith('/passport')));
    return Promise.resolve(key ? { ok: true, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({}) });
  });
}

beforeEach(() => fetchMock.mockReset());

describe('Recent visitors', () => {
  it('shows a face for each person with a name and how long ago, and says these are past visits', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).getByText('Recent visitors')).toBeTruthy();
    expect(within(section).getByText('Who came by lately, newest first. Past visits, not who is online.')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Omar, 1 minute ago' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Sara, 4 minutes ago' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/recent-visitors?scope=universe&id=u1');
  });

  it('is left out when there is nobody to show, or it cannot be read', async () => {
    serve({ '/api/admin/recent-visitors': { visitors: [] } });
    const { container, unmount } = render(<RecentVisitors scope="world" id="w1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();
    serve({});
    const second = render(<RecentVisitors scope="room" id="r1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe('');
  });

  it('opens their profile card when a face is tapped: words, links, stamps and a way to the full profile', async () => {
    serve({
      '/api/admin/recent-visitors': { visitors },
      '/api/admin/users/sara/passport': { stamps: [{ worldId: 'hq', world: 'HQ', universe: { id: 'u-bawes', name: 'BAWES' }, visits: 212, since: '2026-01-12T08:00:00Z' }] },
      '/api/admin/users/sara': { visitCard: { bio: 'Ops at BAWES.', links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/sara' }, { label: 'Bad', url: 'javascript:alert(1)' }] } },
    });
    render(<RecentVisitors scope="universe" id="u1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sara, 4 minutes ago' }));
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Sara' })).toBeTruthy();
    expect(within(sheet).getByText('Here 4 minutes ago · HQ Lobby')).toBeTruthy();
    expect(await within(sheet).findByText('Ops at BAWES.')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'LinkedIn' }).getAttribute('href')).toBe('https://linkedin.com/in/sara');
    expect(within(sheet).queryByRole('link', { name: 'Bad' })).toBeNull();
    expect(within(sheet).getByText('212 visits')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Full profile' }).getAttribute('href')).toBe('/admin/users/sara');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('visitor-sheet')).toBeNull());
  });

  it('still opens the card with name, time and room when the profile cannot be read', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(within(sheet).getByText('Here 1 minute ago · HQ Lobby')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Full profile' })).toBeTruthy();
    expect(within(sheet).queryByText('Ops at BAWES.')).toBeNull();
  });
});
