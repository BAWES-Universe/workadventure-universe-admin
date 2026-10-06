/** @jest-environment jsdom */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { searchMenu } from '@/lib/menu-search';
import { MenuSearchResults } from '@/app/admin/components/shell/menu-search-results';

const mockFetch = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
const response = (data: unknown) => ({ ok: true, json: async () => data });

beforeEach(() => mockFetch.mockReset());
afterEach(() => jest.useRealTimers());

it('reuses discovery permissions, encodes names, and preserves the query when opening all results', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    const key = new URL(url, 'https://orbit.test').pathname.split('/').pop()!;
    return response({
      [key]: [
        {
          id: 'r/1',
          name: 'Design studio',
          world: { name: 'Makers', universe: { name: 'BAWES' } },
        },
      ],
    });
  });
  const results = await searchMenu('Sara & Omar', 'places', new AbortController().signal);
  expect(mockFetch).toHaveBeenCalledTimes(3);
  for (const [url] of mockFetch.mock.calls) {
    const params = new URL(url, 'https://orbit.test').searchParams;
    expect(params.get('scope')).toBe('discover');
    expect(params.get('search')).toBe('Sara & Omar');
  }
  expect(results[0].href).toBe('/admin/discover/rooms?q=Sara%20%26%20Omar');
  expect(results[0].items[0]).toMatchObject({
    href: '/admin/rooms/r%2F1',
    context: 'BAWES / Makers',
  });
});

it('isolates failed groups instead of claiming there are no results everywhere', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    const key = new URL(url, 'https://orbit.test').pathname.split('/').pop()!;
    return key === 'users' ? { ok: false } : response({ [key]: [] });
  });
  const groups = await searchMenu('Sara', 'all', new AbortController().signal);
  expect(groups[0].failed).toBe(true);
  expect(groups.slice(1).every((group) => !group.failed)).toBe(true);
});

it('never fetches directories for a tools-only search', async () => {
  expect(await searchMenu('Bots', 'tools', new AbortController().signal)).toEqual([]);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('debounces, aborts obsolete queries, ignores late answers and aborts on close', async () => {
  jest.useFakeTimers();
  const pending: Array<{
    resolve: (value: unknown) => void;
    signal: AbortSignal;
  }> = [];
  mockFetch.mockImplementation(
    (_url: string, options: RequestInit) => new Promise((resolve) => pending.push({ resolve, signal: options.signal as AbortSignal })),
  );
  const view = render(<MenuSearchResults query="Sara" scope="people" choose={jest.fn()} />);
  expect(mockFetch).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(250));
  view.rerender(<MenuSearchResults query="Omar" scope="people" choose={jest.fn()} />);
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => jest.advanceTimersByTime(250));
  await act(async () => pending[1].resolve(response({ users: [{ id: 'omar', name: 'Omar' }] })));
  expect(screen.getByText('Omar')).toBeTruthy();
  await act(async () => pending[0].resolve(response({ users: [{ id: 'sara', name: 'Sara' }] })));
  expect(screen.queryByText('Sara')).toBeNull();
  view.unmount();
  expect(pending[1].signal.aborted).toBe(true);
});

it('shows an honest error with retry, then recovers', async () => {
  jest.useFakeTimers();
  mockFetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response({ users: [{ id: 's', name: 'Sara' }] }));
  render(<MenuSearchResults query="Sara" scope="people" choose={jest.fn()} />);
  await act(async () => jest.advanceTimersByTime(250));
  expect(screen.getByText(/Couldn’t search people/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await act(async () => jest.advanceTimersByTime(250));
  expect(screen.getByText('Sara')).toBeTruthy();
});
