/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/app/admin/login/page';
import { SESSION_STORAGE_KEY, SESSION_USER_KEY } from '@/lib/client-auth';

describe('Orbit login opened directly, outside Universe', () => {
  const fetchMock = jest.fn();
  const postMessage = jest.spyOn(window, 'postMessage');

  beforeEach(() => {
    window.sessionStorage.clear();
    fetchMock.mockReset();
    postMessage.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('shows the Universe line and makes no API calls, even with a stored session', async () => {
    expect(window.self).toBe(window.top);
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, `orb_sess_v2_${'a'.repeat(64)}`);
    window.sessionStorage.setItem(SESSION_USER_KEY, 'uuid-a');

    render(<LoginPage />);

    expect(await screen.findByText(/Orbit runs inside Universe\./)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open Universe' });
    expect(link.getAttribute('href')).toBe('http://play.workadventure.localhost');
    expect(screen.queryByRole('button', { name: /Continue with Universe/ })).toBeNull();

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(postMessage).not.toHaveBeenCalled();
  });
});
