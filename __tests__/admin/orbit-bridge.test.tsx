/** @jest-environment jsdom */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { REMEMBERED_PAGE_KEY } from '@/lib/orbit-bridge';

const GAME = 'https://play.example.test';
const mockPush = jest.fn();
const mockRefresh = jest.fn();
const mockFetch = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));
jest.mock('@/lib/play-origin', () => ({
  PLAY_ORIGIN: 'https://play.example.test',
  isInsideFrame: () => true,
}));
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, options?: RequestInit) => mockFetch(url, options),
}));

import OrbitBridge from '@/app/admin/components/orbit-bridge';

const revision = 'rev-aaaaaaaaaaaaaaaa';
const otherRevision = 'rev-bbbbbbbbbbbbbbbb';

function fromGame(data: unknown, origin = GAME) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: window }));
  });
}

function init(roomRevision = revision) {
  fromGame({ type: 'orbit-bridge-init', version: 1, roomRevision, capabilities: ['navigate', 'event'] });
}

describe('OrbitBridge', () => {
  let posted: unknown[];

  beforeEach(() => {
    posted = [];
    // In jsdom the frame's parent is the window itself.
    jest.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message);
    });
    mockPush.mockReset();
    mockRefresh.mockReset();
    mockFetch.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  it('tells the game it is ready once mounted (after sign-in)', () => {
    render(<OrbitBridge onRefresh={jest.fn()} />);
    expect(posted).toContainEqual({ type: 'orbit-bridge-ready', version: 1, capabilities: ['navigate', 'event'] });
  });

  it('answers not-ready to a request before the game said which visit it is', () => {
    render(<OrbitBridge onRefresh={jest.fn()} />);
    fromGame({ type: 'orbit-navigate', version: 1, requestId: 'r1', roomRevision: revision, intent: 'new-universe' });
    expect(posted).toContainEqual(expect.objectContaining({ type: 'orbit-bridge-ack', requestId: 'r1', ok: false, error: 'not-ready' }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("refuses a request from the previous room's frame", () => {
    render(<OrbitBridge onRefresh={jest.fn()} />);
    init(revision);
    fromGame({ type: 'orbit-navigate', version: 1, requestId: 'r1', roomRevision: otherRevision, intent: 'new-universe' });
    expect(posted).toContainEqual(expect.objectContaining({ requestId: 'r1', ok: false, error: 'stale-revision' }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores messages from another origin', () => {
    render(<OrbitBridge onRefresh={jest.fn()} />);
    init();
    fromGame({ type: 'orbit-navigate', version: 1, requestId: 'r1', roomRevision: revision, intent: 'new-universe' }, 'https://evil.example.test');
    expect(posted.filter((message) => (message as { type: string }).type === 'orbit-bridge-ack')).toHaveLength(0);
  });

  it('lands on the page Orbit resolved for the intent, then acknowledges', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ path: '/admin/universes/new' }) });
    render(<OrbitBridge onRefresh={jest.fn()} />);
    init();
    fromGame({ type: 'orbit-navigate', version: 1, requestId: 'r1', roomRevision: revision, intent: 'new-universe' });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/universes/new'));
    expect(mockFetch).toHaveBeenCalledWith('/api/orbit-bridge/resolve', expect.objectContaining({ method: 'POST' }));
    expect(posted).toContainEqual(expect.objectContaining({ requestId: 'r1', ok: true }));
  });

  it('falls back to home when resolving fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    render(<OrbitBridge onRefresh={jest.fn()} />);
    init();
    fromGame({ type: 'orbit-navigate', version: 1, requestId: 'r1', roomRevision: revision, intent: 'something-new' });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin'));
  });

  it('refreshes on a refresh hint, and trusts nothing else in it', () => {
    const onRefresh = jest.fn();
    const heard = jest.fn();
    window.addEventListener('orbit:refresh', heard);
    render(<OrbitBridge onRefresh={onRefresh} />);
    init();
    fromGame({ type: 'orbit-event', version: 1, requestId: 'r2', roomRevision: revision, topic: 'universes' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual(expect.objectContaining({ requestId: 'r2', ok: true }));
    window.removeEventListener('orbit:refresh', heard);
  });

  it('forgets the remembered page when the game starts a new visit', () => {
    window.sessionStorage.setItem('orbit_bridge_room_revision', otherRevision);
    window.sessionStorage.setItem(REMEMBERED_PAGE_KEY, JSON.stringify({ roomRevision: otherRevision, path: '/admin/stars' }));
    window.history.pushState({}, '', '/admin/universes');
    render(<OrbitBridge onRefresh={jest.fn()} />);
    init(revision);
    const remembered = JSON.parse(window.sessionStorage.getItem(REMEMBERED_PAGE_KEY) ?? 'null');
    // The previous visit's page is gone; this visit remembers where Orbit is now.
    expect(remembered).toEqual({ roomRevision: revision, path: '/admin/universes' });
  });
});
