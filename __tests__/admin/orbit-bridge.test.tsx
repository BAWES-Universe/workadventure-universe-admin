/** @jest-environment jsdom */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react';

const GAME = 'https://play.example.test';
const mockPush = jest.fn();
const mockRefresh = jest.fn();
const mockFetch = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));
jest.mock('@/lib/play-origin', () => ({
  PLAY_ORIGIN: 'https://play.example.test',
  isInsideFrame: () => true,
}));
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, options?: RequestInit) => mockFetch(url, options),
}));

import OrbitBridge, { inviteInGame, messageInGame, useGameCapability } from '@/app/admin/components/orbit-bridge';

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
    expect(posted).toContainEqual({ type: 'orbit-bridge-ready', version: 1, capabilities: ['navigate', 'event', 'view'] });
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

  describe('handing a person over to the game', () => {
    function Probe() {
      return <span data-testid="can-invite">{String(useGameCapability('invite'))}</span>;
    }

    it('sends nothing before the game said which visit it is', () => {
      render(<OrbitBridge onRefresh={jest.fn()} />);
      expect(inviteInGame('uuid-b', 'Bilal')).toBe(false);
      expect(messageInGame('uuid-b', 'Bilal', '@b:chat')).toBe(false);
      expect(posted.filter((message) => (message as { type: string }).type.startsWith('orbit-invite') || (message as { type: string }).type.startsWith('orbit-message'))).toHaveLength(0);
    });

    it('sends nothing for what the game did not say it can do', () => {
      render(<OrbitBridge onRefresh={jest.fn()} />);
      init();
      expect(inviteInGame('uuid-b', 'Bilal')).toBe(false);
      expect(messageInGame('uuid-b', 'Bilal', '@b:chat')).toBe(false);
    });

    it('invites and messages with the visit’s revision when the game can', () => {
      render(<OrbitBridge onRefresh={jest.fn()} />);
      fromGame({ type: 'orbit-bridge-init', version: 1, roomRevision: revision, capabilities: ['navigate', 'invite', 'message'] });
      expect(inviteInGame('uuid-b', 'Bilal')).toBe(true);
      expect(messageInGame('uuid-b', 'Bilal', '@b:chat')).toBe(true);
      expect(posted).toContainEqual({ type: 'orbit-invite-person', version: 1, roomRevision: revision, uuid: 'uuid-b', name: 'Bilal' });
      expect(posted).toContainEqual({ type: 'orbit-message-person', version: 1, roomRevision: revision, uuid: 'uuid-b', name: 'Bilal', chatId: '@b:chat' });
    });

    it('lets a page follow what the game can do', () => {
      const { getByTestId } = render(
        <>
          <OrbitBridge onRefresh={jest.fn()} />
          <Probe />
        </>,
      );
      expect(getByTestId('can-invite').textContent).toBe('false');
      fromGame({ type: 'orbit-bridge-init', version: 1, roomRevision: revision, capabilities: ['invite'] });
      expect(getByTestId('can-invite').textContent).toBe('true');
    });
  });
});
