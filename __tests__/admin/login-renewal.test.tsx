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

function gameSays(data: Record<string, unknown>) {
  const nonce = (postMessage.mock.calls.at(-1)?.[0] as { nonce: string }).nonce;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { version: 2, nonce, ...data }, origin: PLAY_ORIGIN, source: window }));
  });
}

function gameSends(accessToken: string) {
  gameSays({ type: 'orbit-auth-token-v2', accessToken });
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
    expect(await screen.findByText('Couldn’t sign you in')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/Authentication failed/)).toBeNull();
    expect(window.sessionStorage.getItem('orbit_session_v2')).toBeNull();
  });

  it('drops a session left in this tab when the renewed token is refused too', async () => {
    window.sessionStorage.setItem('orbit_session_v2', SESSION);
    fetchMock.mockImplementation(() => answer(401, { error: 'Invalid or expired access token' }));
    render(<LoginPage />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    gameSends('stale');
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    gameSends('still-stale');
    expect(await screen.findByText('Couldn’t sign you in')).toBeTruthy();
    expect(window.sessionStorage.getItem('orbit_session_v2')).toBeNull();
  });

  it('tries a renewal again when the person clicks Try again after a refusal', async () => {
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
    await screen.findByText('Couldn’t sign you in');

    renewedAvailable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3));
    expect(postMessage.mock.calls[2][0]).not.toHaveProperty('refresh');
    gameSends('stale');
    // Refused again, so the page asks the game to renew rather than giving up.
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(4));
    expect(postMessage.mock.calls[3][0]).toEqual(expect.objectContaining({ type: 'orbit-auth-ready-v2', refresh: true }));
    gameSends('fresh');
    await waitFor(() => expect(window.sessionStorage.getItem('orbit_session_v2')).toBe(SESSION));
  });

  it('keeps the room Orbit was opened from when it has to sign in again', async () => {
    // A session that ran out sends Orbit back here without the room in the address; it is still the same game frame.
    window.sessionStorage.setItem('orbit_play_uri', 'http://play.test/@/uni/world/room');
    fetchMock.mockImplementation((url) => (url === '/api/auth/login' ? answer(200, { version: 2, sessionId: SESSION, expiresAt: Date.now() + 60_000 }) : answer(404, {})));
    render(<LoginPage />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    gameSends('fresh');
    await waitFor(() => expect(window.sessionStorage.getItem('orbit_session_v2')).toBe(SESSION));
    expect(window.sessionStorage.getItem('orbit_play_uri')).toBe('http://play.test/@/uni/world/room');
  });
});

describe('signing in while the connection is slow or down', () => {
  let online = true;

  beforeEach(() => {
    // The page starts its handshake in a microtask: only the clocks are faked.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    fetchMock.mockReset();
    postMessage.mockReset();
    window.sessionStorage.clear();
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.defineProperty(window, 'self', { value: {}, configurable: true });
    window.postMessage = postMessage as unknown as typeof window.postMessage;
    online = true;
    Object.defineProperty(window.navigator, 'onLine', { get: () => online, configurable: true });
    if (!('randomUUID' in crypto)) Object.assign(crypto, { randomUUID: () => 'nonce-' + Math.random().toString(16).slice(2).padEnd(16, '0') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function opened() {
    render(<LoginPage />);
    await act(async () => { await Promise.resolve(); });
    expect(postMessage).toHaveBeenCalledTimes(1);
  }

  it('keeps the plain loader for the first seconds, then says it is still signing in', async () => {
    await opened();
    expect(screen.getByText('Loading your orbit…')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(4_000); });
    expect(screen.getByText('Still signing you in…')).toBeTruthy();
    expect(screen.getByText('Your connection is slow.')).toBeTruthy();
  });

  it('says it is waiting for the connection while the browser is offline', async () => {
    await opened();
    online = false;
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByText('Waiting for your connection…')).toBeTruthy();
    expect(screen.getByText('Orbit opens by itself when you’re back online.')).toBeTruthy();
    online = true;
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(screen.queryByText('Waiting for your connection…')).toBeNull();
  });

  it('keeps waiting past ten seconds while the game says it is still getting a token, then signs in', async () => {
    fetchMock.mockImplementation((url) => (url === '/api/auth/login' ? answer(200, { version: 2, sessionId: SESSION, expiresAt: Date.now() + 60_000 }) : answer(404, {})));
    await opened();
    gameSays({ type: 'orbit-auth-wait-v2' });
    act(() => { jest.advanceTimersByTime(30_000); });
    expect(screen.queryByText(/Orbit runs inside Universe/)).toBeNull();
    gameSays({ type: 'orbit-auth-wait-v2' });
    act(() => { jest.advanceTimersByTime(30_000); });
    expect(screen.queryByText(/Orbit runs inside Universe/)).toBeNull();
    gameSends('fresh');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    jest.useRealTimers();
    await waitFor(() => expect(window.sessionStorage.getItem('orbit_session_v2')).toBe(SESSION));
  });

  it('still says Orbit runs inside Universe when no game ever answers', async () => {
    await opened();
    act(() => { jest.advanceTimersByTime(10_000); });
    expect(screen.getByText(/Orbit runs inside Universe/)).toBeTruthy();
  });

  it('drops a session left in this tab when the game says it cannot get a token', async () => {
    window.sessionStorage.setItem('orbit_session_v2', SESSION);
    await opened();
    gameSays({ type: 'orbit-auth-failed-v2' });
    expect(screen.getByText('Couldn’t sign you in')).toBeTruthy();
    expect(window.sessionStorage.getItem('orbit_session_v2')).toBeNull();
  });

  it('offers Try again when the game says it cannot get a token, and asks the game again on a tap', async () => {
    await opened();
    gameSays({ type: 'orbit-auth-wait-v2' });
    gameSays({ type: 'orbit-auth-failed-v2' });
    expect(screen.getByText('Couldn’t sign you in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][0]).toEqual(expect.objectContaining({ type: 'orbit-auth-ready-v2' }));
  });

  it('ignores a word from the game about an older request', async () => {
    await opened();
    const oldNonce = (postMessage.mock.calls[0][0] as { nonce: string }).nonce;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'orbit-auth-failed-v2', version: 2, nonce: oldNonce + 'x' }, origin: PLAY_ORIGIN, source: window }));
    });
    expect(screen.queryByText('Couldn’t sign you in')).toBeNull();
  });

  it('asks the game again when its own sign-in call never got an answer', async () => {
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new TypeError('Failed to fetch')) : answer(200, { version: 2, sessionId: SESSION, expiresAt: Date.now() + 60_000 });
    });
    await opened();
    gameSends('fresh');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    gameSends('fresh');
    jest.useRealTimers();
    await waitFor(() => expect(window.sessionStorage.getItem('orbit_session_v2')).toBe(SESSION));
  });
});
