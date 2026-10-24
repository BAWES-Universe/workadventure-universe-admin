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
import { ProfileLinks } from '@/app/admin/components/profile-card';

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

  describe('profile links the game can show', () => {
    const links = [
      { label: 'About', url: 'https://mishari.example/about' },
      { label: 'LinkedIn', url: 'https://www.linkedin.com/in/mishari' },
      { label: 'Old site', url: 'http://mishari.example' },
    ];
    const sent = (type: string) => posted.filter((message) => (message as { type: string }).type === type);
    const pill = (container: HTMLElement, label: string) =>
      [...container.querySelectorAll('a')].find((link) => link.textContent === label) as HTMLAnchorElement;

    function show(capabilities = ['navigate', 'open-link']) {
      const view = render(
        <>
          <OrbitBridge onRefresh={jest.fn()} />
          <ProfileLinks links={links} />
        </>,
      );
      fromGame({ type: 'orbit-bridge-init', version: 1, roomRevision: revision, capabilities });
      return view;
    }

    function answer(openHere: string[], requestId = (sent('orbit-check-links')[0] as { requestId: string }).requestId, roomRevision = revision) {
      fromGame({ type: 'orbit-links', version: 1, requestId, roomRevision, openHere });
    }

    it('asks the game about the https links only, once', () => {
      show();
      expect(sent('orbit-check-links')).toEqual([
        expect.objectContaining({ version: 1, roomRevision: revision, urls: [links[0].url, links[1].url] }),
      ]);
    });

    it('opens a link the game can show in its window, without the new-tab icon', () => {
      const { container } = show();
      answer([links[0].url]);
      const about = pill(container, 'About');
      expect(about.querySelector('svg')).toBeNull();
      expect(pill(container, 'LinkedIn').querySelector('svg')).not.toBeNull();
      expect(pill(container, 'Old site').querySelector('svg')).not.toBeNull();

      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      act(() => {
        about.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
      expect(sent('orbit-open-link')).toEqual([{ type: 'orbit-open-link', version: 1, roomRevision: revision, url: links[0].url }]);
    });

    it('leaves a Ctrl click, and links the game refused, to open a new tab', () => {
      const { container } = show();
      answer([links[0].url]);
      const ctrlClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
      const plainClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      act(() => {
        pill(container, 'About').dispatchEvent(ctrlClick);
        pill(container, 'LinkedIn').dispatchEvent(plainClick);
      });
      expect(ctrlClick.defaultPrevented).toBe(false);
      expect(plainClick.defaultPrevented).toBe(false);
      expect(sent('orbit-open-link')).toHaveLength(0);
    });

    it("ignores an answer for another visit, or one it didn't ask for", () => {
      const { container } = show();
      answer([links[0].url], undefined, otherRevision);
      answer([links[0].url], 'links-999');
      expect(pill(container, 'About').querySelector('svg')).not.toBeNull();
    });

    it('asks nothing in a game that cannot open links, and every link keeps its icon', () => {
      const { container } = show(['navigate']);
      expect(sent('orbit-check-links')).toHaveLength(0);
      expect(container.querySelectorAll('svg')).toHaveLength(3);
    });

    it('keeps the new-tab icon when the game never answers', () => {
      jest.useFakeTimers();
      try {
        const { container } = show();
        act(() => {
          jest.advanceTimersByTime(10_000);
        });
        expect(pill(container, 'About').querySelector('svg')).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
