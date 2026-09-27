/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/app/admin/login/page';

const PLAY_ORIGIN = 'http://play.workadventure.localhost';
const SESSION = `orb_sess_v2_${'a'.repeat(64)}`;

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }), useSearchParams: () => new URLSearchParams() }));

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
const postMessage = jest.fn();

function answer(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

function gameSends(accessToken: string) {
  const nonce = (postMessage.mock.calls.at(-1)?.[0] as { nonce: string }).nonce;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'orbit-auth-token-v2', version: 2, nonce, accessToken }, origin: PLAY_ORIGIN, source: window }));
  });
}

describe('signing in when the game’s access token has run out', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    postMessage.mockReset();
    window.sessionStorage.clear();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Inside the game's frame: a parent that isn't us, and a way to post to it.
    Object.defineProperty(window, 'self', { value: {}, configurable: true });
    window.postMessage = postMessage as unknown as typeof window.postMessage;
    if (!('randomUUID' in crypto)) Object.assign(crypto, { randomUUID: () => 'nonce-' + Math.random().toString(16).slice(2).padEnd(16, '0') });
  });

  it('asks the game for a renewed token once, then signs in with it', async () => {
    fetchMock.mockImplementation((url, init) => {
      if (url !== '/api/auth/login') return answer(404, {});
      const { accessToken } = JSON.parse(String(init?.body)) as { accessToken: string };
      return accessToken === 'stale' ? answer(401, { error: 'Invalid or expired access token' }) : answer(200, { version: 2, sessionId: SESSION, expiresAt: Date.now() + 60_000 });
    });
    render(<LoginPage />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0][0]).toEqual(expect.objectContaining({ type: 'orbit-auth-ready-v2', version: 2 }));
    expect(postMessage.mock.calls[0][0]).not.toHaveProperty('refresh');

    gameSends('stale');
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(postMessage.mock.calls[1][0]).toEqual(expect.objectContaining({ type: 'orbit-auth-ready-v2', refresh: true }));

    gameSends('fresh');
    // The session is stored (the page then moves on to /admin, which jsdom can't do).
    await waitFor(() => expect(window.sessionStorage.getItem('orbit_session_v2')).toBe(SESSION));
    expect(screen.queryByText(/Authentication failed/)).toBeNull();
  });

  it('explains what to do when the renewed token is refused too', async () => {
    fetchMock.mockImplementation(() => answer(401, { error: 'Invalid or expired access token' }));
    render(<LoginPage />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    gameSends('stale');
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    gameSends('still-stale');
    expect(await screen.findByText(/Your Universe sign-in has expired/)).toBeTruthy();
    expect(window.sessionStorage.getItem('orbit_session_v2')).toBeNull();
  });

  it('tries a renewal again when the person clicks Continue with Universe after a refusal', async () => {
    let renewedAvailable = false;
    fetchMock.mockImplementation((url, init) => {
      if (url !== '/api/auth/login') return answer(404, {});
      const { accessToken } = JSON.parse(String(init?.body)) as { accessToken: string };
      return accessToken === 'fresh' && renewedAvailable
        ? answer(200, { version: 2, sessionId: SESSION, expiresAt: Date.now() + 60_000 })
        : answer(401, { error: 'Invalid or expired access token' });
    });
    render(<LoginPage />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    gameSends('stale');
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    gameSends('still-stale');
    await screen.findByText(/Your Universe sign-in has expired/);

    renewedAvailable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Universe' }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3));
    expect(postMessage.mock.calls[2][0]).not.toHaveProperty('refresh');
    gameSends('stale');
    // Refused again, so the page asks the game to renew rather than giving up.
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(4));
    expect(postMessage.mock.calls[3][0]).toEqual(expect.objectContaining({ type: 'orbit-auth-ready-v2', refresh: true }));
    gameSends('fresh');
    await waitFor(() => expect(window.sessionStorage.getItem('orbit_session_v2')).toBe(SESSION));
  });
});
