/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminShell from '@/app/admin/admin-shell';
import { WorkAdventureContext } from '@/app/admin/workadventure-context';
import type { OrbitView } from '@/lib/orbit-bridge';

let mockPathname = '/admin';
const mockRouter = { back: jest.fn(), replace: jest.fn(), push: jest.fn(), refresh: jest.fn() };
const mockGetClientSessionId = jest.fn(() => `orb_sess_v2_${'a'.repeat(64)}`);
const closeModal = jest.fn();
const mockRequestView = jest.fn();
let mockGameConfirmsView = true;
let mockConfirmView: ((view: OrbitView) => void) | undefined;

const adminLinks = [
  ['Avatar Sets', '/admin/avatars'],
  ['Bots', '/admin/bots'],
  ['AI Providers', '/admin/ai-providers'],
  ['AI Usage', '/admin/ai-providers/usage'],
  ['Bot Database', '/admin/bots/database'],
  ['MCP Servers', '/admin/bots/mcp-servers'],
] as const;
const personalLinks = [
  ['My Universes', '/admin/universes'],
  ['My Stars', '/admin/stars'],
  ['My Memberships', '/admin/memberships'],
  ['My Visit Card', '/admin/profile'],
  ['Room Templates', '/admin/templates'],
  ['Users', '/admin/users'],
] as const;

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
  requestView: (view: string) => mockRequestView(view),
  postToGame: jest.fn(),
}));
jest.mock('@/app/admin/components/orbit-bridge', () => ({
  __esModule: true,
  default: function MockOrbitBridge({ onView }: { onView?: (view: OrbitView) => void }) {
    React.useEffect(() => {
      mockConfirmView = onView;
      if (mockGameConfirmsView) onView?.('compact');
      return () => { mockConfirmView = undefined; };
    }, [onView]);
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

async function renderShell(pathname = '/admin', response: unknown = bootstrap) {
  mockPathname = pathname;
  window.history.replaceState({ __NA: true }, '', pathname);
  const view = render(
    <AdminShell>
      <div>page content</div>
    </AdminShell>,
  );
  await waitFor(() => expect(mockAuthenticatedFetch).toHaveBeenCalled());
  await act(async () => answerLast(response));
  await screen.findByText('page content');
  return view;
}

describe('AdminShell', () => {
  beforeEach(() => {
    mockPathname = '/admin';
    window.history.replaceState({ __NA: true }, '', '/admin');
    pendingResponses = [];
    mockAuthenticatedFetch.mockClear();
    mockGetClientSessionId.mockClear();
    closeModal.mockClear();
    mockRequestView.mockClear();
    mockGameConfirmsView = true;
    mockConfirmView = undefined;
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

  it('gives a directly opened detail page a Back to its parent', async () => {
    await renderShell('/admin/worlds/w-1');
    const back = screen.getByTestId('orbit-back');
    expect(back.getAttribute('aria-label')).toBe('Back');
    expect(screen.getByTestId('orbit-title').textContent).toBe('World');
    fireEvent.click(back);
    // The first page of a visit: its parent takes its place, so the browser's Back still closes Orbit.
    expect(mockRouter.replace).toHaveBeenCalledWith('/admin/spaces');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('Back returns along Orbit’s own pages before going to a parent', async () => {
    const view = await renderShell('/admin/spaces');
    act(() => {
      mockPathname = '/admin/worlds/w-1';
      // Next writes an entry when navigation commits. A changed pathname by
      // itself could equally be a replace, Back or Forward, so is not proof.
      window.history.pushState({ __NA: true }, '', mockPathname);
      view.rerender(
        <AdminShell>
          <div>page content</div>
        </AdminShell>,
      );
    });
    fireEvent.click(screen.getByTestId('orbit-back'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('Escape dismisses the real menu before Orbit and restores focus to its opener', async () => {
    await renderShell('/admin');
    const opener = screen.getByRole('button', { name: 'Open Orbit menu' });
    fireEvent.click(opener);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape', cancelable: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(closeModal).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.keyDown(opener, { key: 'Escape', cancelable: true });
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it('Escape closes only the top layer: a dialog first, an edited field next, Orbit last', async () => {
    await renderShell('/admin');
    // A dialog handled it (Radix marks the event as handled).
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    handled.preventDefault();
    act(() => {
      document.body.dispatchEvent(handled);
    });
    expect(closeModal).not.toHaveBeenCalled();

    // A field being edited lets go of focus instead.
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).not.toBe(input);
    expect(closeModal).not.toHaveBeenCalled();
    input.remove();

    // Nothing above the page: Orbit closes through the game.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it('offers the full-screen view and asks the game for it', async () => {
    await renderShell('/admin');
    fireEvent.click(screen.getByRole('button', { name: /open orbit menu/i }));
    fireEvent.click(screen.getByTestId('orbit-view-toggle'));
    expect(mockRequestView).toHaveBeenCalledWith('full');
    // Actual view changes only on the host's bridge confirmation; the menu closes after requesting.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open orbit menu/i }));
    expect(screen.getByTestId('orbit-view-toggle')).toHaveAttribute('aria-label', 'Open in full screen');
    act(() => mockConfirmView?.('full'));
    expect(screen.getByTestId('orbit-view-toggle')).toHaveAttribute('aria-label', 'Back to the compact view');
  });

  it('does not offer an inert view control when an older game never confirms view support', async () => {
    mockGameConfirmsView = false;
    await renderShell('/admin');
    fireEvent.click(screen.getByRole('button', { name: /open orbit menu/i }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.queryByTestId('orbit-view-toggle')).toBeNull();
    expect(mockRequestView).not.toHaveBeenCalled();
  });

  it('keeps every super-admin tool reachable from the menu', async () => {
    await renderShell('/admin');
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    const menu = await screen.findByRole('dialog');
    for (const [label, href] of [...adminLinks, ...personalLinks]) {
      expect(within(menu).getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
    expect(menu.textContent).toContain('Sign out');
  });

  it('hides admin tools from ordinary users while keeping personal, template and user links', async () => {
    await renderShell('/admin', { ...bootstrap, user: { ...bootstrap.user, isSuperAdmin: false } });
    fireEvent.click(screen.getByRole('button', { name: /open orbit menu/i }));
    const menu = await screen.findByRole('dialog');
    for (const [label] of adminLinks) {
      expect(within(menu).queryByRole('link', { name: label })).toBeNull();
    }
    for (const [label, href] of personalLinks) {
      expect(within(menu).getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it('opens the menu with the keyboard shortcut without covering an alert dialog or stealing a handled key', async () => {
    await renderShell('/admin');
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alertdialog');
    alert.setAttribute('data-state', 'open');
    document.body.append(alert);
    fireEvent.keyDown(alert, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    alert.remove();

    const handled = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => { document.body.dispatchEvent(handled); });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(closeModal).not.toHaveBeenCalled();
  });
});
