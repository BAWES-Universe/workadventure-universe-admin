/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminShell from '@/app/admin/admin-shell';
import { WorkAdventureContext } from '@/app/admin/workadventure-context';
import { useReplacePage } from '@/app/admin/orbit-frame-context';

let mockPathname = '/admin';
const mockRouter = { back: jest.fn(), replace: jest.fn(), push: jest.fn(), refresh: jest.fn() };
const mockGetClientSessionId = jest.fn(() => `orb_sess_v2_${'a'.repeat(64)}`);
const closeModal = jest.fn();

const bootstrap = {
  version: 1,
  user: { id: 'u1', uuid: 'uuid-1', name: 'Khalid', email: 'k@example.test', tags: [], isSuperAdmin: true },
  stats: { universes: 3, worlds: 5, rooms: 9, users: 12 },
  mine: { universes: 1, worlds: 2, stars: 3, invitations: 0 },
};

let pendingResponses: Array<{ resolve: (response: Response) => void }> = [];
const mockAuthenticatedFetch = jest.fn<Promise<Response>, [string, RequestInit?]>(
  () =>
    new Promise<Response>((resolve) => {
      pendingResponses.push({ resolve });
    }),
);
function answerLast(body: unknown = bootstrap, status = 200) {
  const pending = pendingResponses.pop();
  pending?.resolve({ ok: status < 400, status, json: async () => body } as unknown as Response);
}

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', setTheme: jest.fn() }) }));
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, options?: RequestInit) => mockAuthenticatedFetch(url, options),
  getClientSessionId: () => mockGetClientSessionId(),
  clearClientSession: jest.fn(),
}));
jest.mock('@/lib/orbit-frame', () => ({
  isInsideFrame: () => true,
  postToGame: jest.fn(),
}));
let mockOnRefresh: (() => void) | null = null;
jest.mock('@/app/admin/components/orbit-bridge', () => ({
  __esModule: true,
  default: ({ onRefresh }: { onRefresh: () => void }) => {
    mockOnRefresh = onRefresh;
    return null;
  },
}));
jest.mock('@/app/admin/workadventure-provider', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <WorkAdventureContext.Provider
      value={{
        wa: { ui: { modal: { closeModal } } } as never,
        isReady: true,
        isLoading: false,
        error: null,
        navigateToRoom: jest.fn(),
      }}
    >
      {children}
    </WorkAdventureContext.Provider>
  ),
}));

async function renderShell(pathname = '/admin') {
  mockPathname = pathname;
  const view = render(
    <AdminShell>
      <div>page content</div>
    </AdminShell>,
  );
  await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalled());
  await act(async () => answerLast());
  await screen.findByText('page content');
  return view;
}

// A page that looks new counts once the task that rendered it ends (a popstate may still be on its way).
const endTask = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('AdminShell', () => {
  beforeEach(() => {
    mockPathname = '/admin';
    pendingResponses = [];
    mockAuthenticatedFetch.mockClear();
    mockGetClientSessionId.mockClear();
    closeModal.mockClear();
    Object.values(mockRouter).forEach((fn) => fn.mockClear());
  });

  it('shows the loader only until the session is loaded, then keeps the page in place while navigating', async () => {
    mockPathname = '/admin';
    const view = render(
      <AdminShell>
        <div>page content</div>
      </AdminShell>,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(1));
    await act(async () => answerLast());
    expect(await screen.findByText('page content')).toBeTruthy();

    act(() => {
      mockPathname = '/admin/bots';
      view.rerender(
        <AdminShell>
          <div>bots page</div>
        </AdminShell>,
      );
    });
    // The new page is there at once; the session check runs behind it.
    expect(screen.getByText('bots page')).toBeTruthy();
    expect(screen.queryByText(/Loading your orbit/)).toBeNull();
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2));
    expect(mockAuthenticatedFetch.mock.calls[1][0]).toBe('/api/auth/me');
  });

  it('aborts the previous request when navigation changes', async () => {
    const view = await renderShell('/admin');
    act(() => {
      mockPathname = '/admin/bots';
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2));
    const secondSignal = (mockAuthenticatedFetch.mock.calls[1][1] as RequestInit).signal as AbortSignal;
    act(() => {
      mockPathname = '/admin/avatars';
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(3));
    expect(secondSignal.aborted).toBe(true);
  });

  it('gives every page a Back that names where it goes, and roots the wordmark', async () => {
    await renderShell('/admin/worlds/w-1');
    const back = screen.getByTestId('orbit-back');
    expect(back.textContent).toContain('Space');
    // The page carries its own heading; the bar doesn't repeat it.
    expect(screen.queryByTestId('orbit-title')).toBeNull();
    fireEvent.click(back);
    // The first page of a visit: its parent takes its place, so the browser's Back still closes Orbit.
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/space');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('Back returns along Orbit’s own pages before going to a parent', async () => {
    const view = await renderShell('/admin/space');
    act(() => {
      mockPathname = '/admin/worlds/w-1';
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    await endTask();
    fireEvent.click(screen.getByTestId('orbit-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('Back is named after the page it returns to, and survives Back then Forward', async () => {
    const view = await renderShell('/admin/stars');
    const go = async (path: string, pop = false) => {
      act(() => {
        if (pop) window.dispatchEvent(new PopStateEvent('popstate'));
        mockPathname = path;
        view.rerender(
          <AdminShell>
            <div>page content</div>
          </AdminShell>,
        );
      });
      await endTask();
    };
    await go('/admin/rooms/r-1');
    // Opened from Stars: Back says Stars, not the room's usual parent.
    expect(screen.getByTestId('orbit-back').textContent).toContain('Stars');
    await go('/admin/stars', true); // browser Back
    await go('/admin/rooms/r-1', true); // browser Forward
    expect(screen.getByTestId('orbit-back').textContent).toContain('Stars');
    fireEvent.click(screen.getByTestId('orbit-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('Back pressed twice before a render walks two steps, and Forward comes back along them', async () => {
    const view = await renderShell('/admin/stars');
    const go = async (path: string, pops = 0) => {
      act(() => {
        for (let i = 0; i < pops; i += 1) window.dispatchEvent(new PopStateEvent('popstate'));
        mockPathname = path;
        view.rerender(
          <AdminShell>
            <div>page content</div>
          </AdminShell>,
        );
      });
      await endTask();
    };
    await go('/admin/rooms/r-1');
    await go('/admin/worlds/w-1');
    await go('/admin/stars', 2); // two quick Backs, one render
    expect(screen.getByTestId('orbit-back').textContent).not.toContain('Room');
    await go('/admin/rooms/r-1', 1); // Forward
    expect(screen.getByTestId('orbit-back').textContent).toContain('Stars');
    await go('/admin/worlds/w-1', 1); // Forward again
    fireEvent.click(screen.getByTestId('orbit-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('a Back the page shows before the browser’s popstate arrives still counts as Back', async () => {
    const view = await renderShell('/admin/stars');
    const render = (path: string) => {
      mockPathname = path;
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    };
    act(() => render('/admin/rooms/r-1'));
    await endTask();
    act(() => render('/admin/worlds/w-1'));
    await endTask();
    // Next renders the page first, then the browser's popstate reaches Orbit, in the same task.
    act(() => render('/admin/rooms/r-1'));
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await endTask();
    expect(screen.getByTestId('orbit-back').textContent).toContain('Stars');
    expect(screen.getByTestId('orbit-back').textContent).not.toContain('World');
  });

  it('a page that sends you on in its own place leaves it out of Back', async () => {
    function SaveButton() {
      const replacePage = useReplacePage();
      return (
        <button type="button" onClick={() => replacePage('/admin/rooms/r-9')}>
          save
        </button>
      );
    }
    const page = () => (
      <AdminShell>
        <div>page content</div>
        <SaveButton />
      </AdminShell>
    );
    const view = await renderShell('/admin/space');
    act(() => {
      mockPathname = '/admin/rooms/new';
      view.rerender(page());
    });
    await endTask();
    expect(screen.getByTestId('orbit-back').textContent).toContain('Space');
    fireEvent.click(screen.getByText('save'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/rooms/r-9');
    expect(mockRouter.push).not.toHaveBeenCalled();
    act(() => {
      mockPathname = '/admin/rooms/r-9';
      view.rerender(page());
    });
    await endTask();
    // The new room took the form's place: Back goes to Space, not to an empty form.
    expect(screen.getByTestId('orbit-back').textContent).toContain('Space');
    expect(screen.getByTestId('orbit-back').textContent).not.toContain('New room');
    fireEvent.click(screen.getByTestId('orbit-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  it('Try again shows the loader, not the last error', async () => {
    mockPathname = '/admin';
    render(
      <AdminShell>
        <div>page content</div>
      </AdminShell>,
    );
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalled());
    await act(async () => answerLast({}, 500));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2));
    await act(async () => answerLast());
    expect(await screen.findByText('page content')).toBeTruthy();
  });

  it('keeps asking for fresh numbers after the game’s refresh fails, until they arrive', async () => {
    const view = await renderShell('/admin/worlds/w1');
    act(() => mockOnRefresh?.());
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(2));
    expect(mockAuthenticatedFetch.mock.calls[1][0]).toBe('/api/admin/bootstrap');
    await act(async () => answerLast({}, 500));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(3));
    expect(mockAuthenticatedFetch.mock.calls[2][0]).toBe('/api/admin/bootstrap');
    await act(async () => answerLast());
    await screen.findByText('page content');
    // Answered: the next inner page only re-checks the session.
    act(() => {
      mockPathname = '/admin/bots';
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(4));
    expect(mockAuthenticatedFetch.mock.calls[3][0]).toBe('/api/auth/me');
  });

  it('drops a failed load’s error as soon as you go to another page', async () => {
    const view = await renderShell('/admin/worlds/w1');
    act(() => {
      mockPathname = '/admin/bots';
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    await act(async () => answerLast({}, 500));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
    act(() => {
      mockPathname = '/admin/avatars';
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    // The new page's load is under way: the last page's error is gone at once.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalledTimes(3));
  });

  it('Escape closes only the top layer: a dialog first, an edited field next, Orbit last', async () => {
    await renderShell('/admin');
    // A dialog handled it (Radix marks the event as handled).
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    handled.preventDefault();
    act(() => {
      window.dispatchEvent(handled);
    });
    expect(closeModal).not.toHaveBeenCalled();

    // A field being edited lets go of focus instead.
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).not.toBe(input);
    expect(closeModal).not.toHaveBeenCalled();
    input.remove();

    // Nothing above the page: Orbit closes through the game.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it('leaves the view to the game: no expand button of its own, and the Menu first in the bar', async () => {
    await renderShell('/admin');
    expect(screen.queryByTestId('orbit-view-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: /full screen|expand|maximi/i })).toBeNull();
    const bar = screen.getByRole('banner');
    const menuButton = bar.querySelector('button');
    expect(menuButton?.textContent).toContain('Orbit Menu');
    // Its shortcut is on the button as keycaps (shown on hover, only with a keyboard and a mouse).
    const keys = Array.from(menuButton?.querySelectorAll('kbd') ?? []).map((key) => key.textContent);
    expect(keys).toEqual(['Ctrl', 'K']);
  });

  it('keeps You, Orbit and Space on the bottom bar, with Orbit in the middle and lit on arrival', async () => {
    await renderShell('/admin');
    const nav = screen.getByRole('navigation', { name: 'Orbit' });
    const links = Array.from(nav.querySelectorAll('a'));
    expect(links.map((link) => link.textContent)).toEqual(['You', 'Orbit', 'Space']);
    expect(links[1].getAttribute('aria-current')).toBe('page');
  });

  it('Ctrl+K and Cmd+K open and close the menu, from any page', async () => {
    await renderShell('/admin/worlds/w-1');
    expect(screen.queryByRole('dialog')).toBeNull();
    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ctrlK);
    });
    expect(ctrlK.defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true, cancelable: true, bubbles: true }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(closeModal).not.toHaveBeenCalled();
  });

  it('Ctrl+K leaves another open dialog alone', async () => {
    await renderShell('/admin');
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('data-state', 'open');
    document.body.append(other);
    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ctrlK);
    });
    expect(ctrlK.defaultPrevented).toBe(false);
    expect(screen.queryByTestId('orbit-menu-button')?.getAttribute('aria-expanded')).toBe('false');
    other.remove();
  });

  it('closes the menu when you choose the page already open', async () => {
    await renderShell('/admin');
    fireEvent.click(screen.getByTestId('orbit-menu-button'));
    const menu = await screen.findByRole('dialog');
    fireEvent.click(within(menu).getByRole('link', { name: 'Orbit' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps every super-admin tool reachable from the menu', async () => {
    await renderShell('/admin');
    fireEvent.click(screen.getByTestId('orbit-menu-button'));
    const menu = await screen.findByRole('dialog');
    for (const label of ['Avatar sets', 'Bots', 'AI providers', 'AI usage', 'Bot database', 'MCP servers']) {
      expect(menu.textContent).toContain(label);
    }
    for (const label of ['Your universes', 'Stars', 'Memberships', 'Profile', 'Room templates', 'People']) {
      expect(menu.textContent).toContain(label);
    }
    // The account, theme and sign-out live on You, not in the menu.
    expect(menu.textContent).not.toContain('Sign out');
  });
});
