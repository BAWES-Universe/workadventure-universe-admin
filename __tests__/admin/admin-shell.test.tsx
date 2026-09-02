/** @jest-environment jsdom */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import AdminShell from '@/app/admin/admin-shell';

let mockPathname = '/admin';
const mockAuthenticatedFetch = jest.fn(
  (_url: string, _options?: RequestInit) => new Promise<Response>(() => undefined)
);
const mockGetClientSessionId = jest.fn(() => `orb_sess_v2_${'a'.repeat(64)}`);

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, options?: RequestInit) => mockAuthenticatedFetch(url, options),
  getClientSessionId: () => mockGetClientSessionId(),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/components/ui/spinner', () => ({
  Spinner: () => null,
}));

jest.mock('@/app/admin/components/conditional-nav', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/app/admin/components/conditional-content', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/app/admin/admin-bootstrap-context', () => ({
  AdminBootstrapProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('AdminShell request lifecycle', () => {
  beforeEach(() => {
    mockPathname = '/admin';
    mockAuthenticatedFetch.mockClear();
    mockGetClientSessionId.mockClear();
  });

  it('aborts the previous bootstrap request when navigation changes', async () => {
    const view = render(<AdminShell><div>content</div></AdminShell>);

    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1));
    const firstSignal = (mockAuthenticatedFetch.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    act(() => {
      mockPathname = '/admin/bots';
      view.rerender(<AdminShell><div>content</div></AdminShell>);
    });

    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect((mockAuthenticatedFetch.mock.calls[1][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
