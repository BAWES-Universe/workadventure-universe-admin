/** @jest-environment jsdom */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

const mockAuthenticatedFetch = jest.fn<Promise<Response>, [string, RequestInit?]>();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, options?: RequestInit) => mockAuthenticatedFetch(url, options),
}));

import { AttentionBadge, announceAttentionChanged, useAttentionCount } from '@/app/admin/components/shell/attention-badge';
import { ORBIT_REFRESH_EVENT } from '@/app/admin/components/orbit-bridge';

function answer(count: number, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => ({ count, invitations: count }) } as unknown as Response);
}

function Counted() {
  const count = useAttentionCount();
  return (
    <a href="/admin/you" className="relative">
      <AttentionBadge count={count} />
      You
    </a>
  );
}

describe('AttentionBadge', () => {
  beforeEach(() => mockAuthenticatedFetch.mockReset());

  it('draws nothing at 0, the number up to 99, then 99+, with words for screen readers', () => {
    const { rerender } = render(<AttentionBadge count={0} />);
    expect(screen.queryByTestId('attention-badge')).toBeNull();
    rerender(<AttentionBadge count={1} />);
    expect(screen.getByTestId('attention-badge')).toHaveTextContent('1 thing waits for your answer');
    rerender(<AttentionBadge count={120} />);
    expect(screen.getByTestId('attention-badge')).toHaveTextContent(/^99\+120 things wait for your answer$/);
  });

  it('shares one request between the rail and the bottom bar, and follows answers and Orbit refreshes', async () => {
    mockAuthenticatedFetch.mockImplementation(() => answer(2));
    render(
      <>
        <Counted />
        <Counted />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('attention-badge')).toHaveLength(2));
    expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1);
    expect(mockAuthenticatedFetch).toHaveBeenCalledWith('/api/me/attention', undefined);
    expect(screen.getAllByTestId('attention-badge')[0]).toHaveTextContent(/^2/);

    mockAuthenticatedFetch.mockImplementation(() => answer(1));
    act(() => announceAttentionChanged());
    await waitFor(() => expect(screen.getAllByTestId('attention-badge')[0]).toHaveTextContent(/^1/));

    mockAuthenticatedFetch.mockImplementation(() => answer(0));
    act(() => {
      window.dispatchEvent(new CustomEvent(ORBIT_REFRESH_EVENT, { detail: { topic: 'memberships' } }));
    });
    await waitFor(() => expect(screen.queryByTestId('attention-badge')).toBeNull());
  });
});
