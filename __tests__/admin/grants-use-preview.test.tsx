/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { usePreview } from '@/app/admin/ai-providers/grants/grants-parts';
import type { PreviewRequest } from '@/lib/grants-view';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const REQUEST = { amount: 5 } as unknown as PreviewRequest;
const answer = (clash: unknown) => ({ ok: true, status: 200, json: async () => ({ numbers: null, clash }) });

describe('usePreview', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  const settle = async () => {
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await act(async () => undefined);
  };

  it('does not show the answer of an earlier run for the same figures when the preview is started again: it waits for a fresh one', async () => {
    fetchMock.mockResolvedValueOnce(answer(null));
    const { result, rerender } = renderHook(({ request }: { request: PreviewRequest | null }) => usePreview(request), { initialProps: { request: REQUEST as PreviewRequest | null } });
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.preview?.clash).toBeNull();
    // The sheet closes, and opens again on the same draft
    rerender({ request: null });
    rerender({ request: REQUEST });
    // The old "no clash" is not stood in for the new answer
    expect(result.current.preview).toBeNull();
    expect(result.current.loading).toBe(true);
    fetchMock.mockResolvedValueOnce(answer({ rule: 'now taken' }));
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.preview?.clash).toEqual({ rule: 'now taken' });
  });
});
