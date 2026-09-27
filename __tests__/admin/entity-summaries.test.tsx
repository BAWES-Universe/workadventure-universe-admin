/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEntitySummaries } from '@/app/admin/hooks/use-entity-summaries';
import { clearSummaryCache, fromAnalytics } from '@/app/admin/hooks/use-room-analytics';
import DiscoverRoomsPage from '@/app/admin/discover/rooms/page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => '/admin/test',
  useSearchParams: () => new URLSearchParams(),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const analyticsCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/analytics/'));
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  clearSummaryCache();
});

function Probe({ ids }: { ids: string[] }) {
  const summaries = useEntitySummaries('rooms', ids);
  return (
    <div>
      {ids.map((id) => (
        <span key={id} data-testid={`state-${id}`}>
          {summaries.get(id).status}
        </span>
      ))}
      <button type="button" onClick={() => summaries.retry()}>
        retry
      </button>
    </div>
  );
}

describe('useEntitySummaries', () => {
  it('asks once per id when the server keeps refusing, however often the list re-renders', async () => {
    fetchMock.mockImplementation(() => json(503, { error: 'unavailable' }));
    const { rerender } = render(<Probe ids={['a', 'b', 'c']} />);
    await waitFor(() => expect(screen.getByTestId('state-c').textContent).toBe('error'));
    // New arrays with the same ids, many times over: no new requests.
    for (let i = 0; i < 5; i += 1) rerender(<Probe ids={['a', 'b', 'c']} />);
    await settle();
    // The three cards' numbers go out together: one request.
    expect(analyticsCalls()).toHaveLength(1);
    expect(String(analyticsCalls()[0][0])).toContain('ids=a%2Cb%2Cc');

    // An explicit retry asks again, once, for every failed id.
    fireEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(analyticsCalls()).toHaveLength(2));
    await settle();
    expect(screen.getByTestId('state-a').textContent).toBe('error');
    expect(analyticsCalls()).toHaveLength(2);
  });

  it('keeps an answer that lands after the list grew, for a place still listed', async () => {
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    fetchMock.mockImplementation(() => json(200, { summaries: {} }));
    const { rerender } = render(<Probe ids={['a']} />);
    await waitFor(() => expect(analyticsCalls()).toHaveLength(1));
    // The list changes while "a" is still being answered.
    rerender(<Probe ids={['a', 'b']} />);
    await act(async () => answer({ ok: true, status: 200, json: () => Promise.resolve({ totalAccesses: 3, summaries: { a: { totalAccesses: 3 } } }) } as Response));
    await waitFor(() => expect(screen.getByTestId('state-a').textContent).toBe('ready'));
  });

  it('keeps a bounded number of requests on the discover page when every analytics call is 503', async () => {
    const rooms = ['r1', 'r2', 'r3'].map((id) => ({
      id,
      slug: id,
      name: `Room ${id}`,
      description: null,
      mapUrl: null,
      isPublic: true,
      world: { id: 'w', name: 'World', slug: 'w', universe: { id: 'u', name: 'Uni', slug: 'u' } },
    }));
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json(200, { user: { id: 'me' } });
      if (url.startsWith('/api/admin/rooms')) return json(200, { rooms, pagination: { total: 3, totalPages: 1 } });
      return json(503, { error: 'unavailable' });
    });
    render(<DiscoverRoomsPage />);
    await screen.findByText('Room r1');
    await waitFor(() => expect(screen.getByText(/activity for some rooms/)).toBeTruthy());
    await settle();
    await settle();
    expect(analyticsCalls()).toHaveLength(1);
  });
});

describe('analytics summary', () => {
  it('reads the peak from the all-time UTC buckets on the viewer’s clock, and "you were last" from the server', () => {
    const summary = fromAnalytics({
      totalAccesses: 12,
      // Recent activity says 9 o'clock local, but the all-time buckets win.
      recentActivity: [{ accessedAt: new Date(new Date().setHours(9, 0, 0, 0)).toISOString() }],
      peakTimes: [
        { hour: 16, count: 40 },
        { hour: 3, count: 2 },
      ],
      lastVisitedByUser: { accessedAt: '2026-09-01T10:00:00Z' },
      lastVisitedOverall: { accessedAt: '2026-09-01T10:00:00Z' },
      youWereLast: false,
    });
    const at = new Date();
    at.setUTCHours(16, 0, 0, 0);
    expect(summary.peakHour).toBe(at.getHours());
    // Equal timestamps are not identity.
    expect(summary.youWereLast).toBe(false);
    expect(fromAnalytics({ lastVisitedOverall: { accessedAt: '2026-09-01T10:00:00Z' }, youWereLast: true }).youWereLast).toBe(true);
  });
});
