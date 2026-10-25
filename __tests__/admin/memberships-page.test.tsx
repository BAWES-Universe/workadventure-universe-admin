/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MyMembershipsPage from '@/app/admin/memberships/page';
import { clearSummaryCache } from '@/app/admin/hooks/use-room-analytics';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const invitation = (id: string, name: string) => ({
  id,
  world: { id: `w-${id}`, name, slug: id, universe: { id: 'u', name: 'Uni', slug: 'u' } },
  invitedBy: { id: 'x', name: 'Khalid', email: null },
  invitedAt: '2026-09-01T00:00:00Z',
  tags: ['member'],
  message: null,
});

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  clearSummaryCache();
});

describe('Memberships', () => {
  it('shows a failed list as an error with a retry, never as "No memberships yet", until an empty answer arrives', async () => {
    let membershipsOk = false;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: [] });
      if (url === '/api/memberships/my/universes') return membershipsOk ? json({ universes: [] }) : json({ error: 'down' }, 503);
      return json({});
    });
    render(<MyMembershipsPage />);
    await screen.findByText(/couldn’t load your memberships/);
    expect(screen.queryByText('No memberships yet.')).toBeNull();

    membershipsOk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No memberships yet.');
    expect(screen.queryByText(/couldn’t load/)).toBeNull();
  });

  it('offers a compact retry when invitations fail to load', async () => {
    let invitationsOk = false;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations')
        return invitationsOk ? json({ invitations: [invitation('i1', 'Moon')] }) : json({}, 500);
      if (url === '/api/memberships/my/universes') return json({ universes: [] });
      return json({});
    });
    render(<MyMembershipsPage />);
    await screen.findByText(/couldn’t load your invitations/);
    invitationsOk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('invitations');
    expect(screen.queryByText(/couldn’t load your invitations/)).toBeNull();
  });

  it('locks each invitation on its own while its answer and the reload are on their way', async () => {
    const answers: Array<() => void> = [];
    let remaining = [invitation('i1', 'Moon'), invitation('i2', 'Mars')];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: remaining });
      if (url === '/api/memberships/my/universes') return json({ universes: [] });
      if (init?.method === 'POST') {
        const id = url.split('/')[4];
        return new Promise((resolve) =>
          answers.push(() => {
            remaining = remaining.filter((item) => item.id !== id);
            resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
          }),
        );
      }
      return json({});
    });
    render(<MyMembershipsPage />);
    await screen.findByTestId('invitations');

    const acceptMoon = screen.getAllByRole('button', { name: /Accept/ })[0];
    fireEvent.click(acceptMoon);
    await waitFor(() => expect(answers).toHaveLength(1));
    // Moon is locked; Mars is not.
    expect((screen.getByRole('button', { name: 'Decline the invitation to Moon' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Decline the invitation to Mars' }) as HTMLButtonElement).disabled).toBe(false);
    // Declining asks first: the ✕ alone sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Decline the invitation to Mars' }));
    expect(answers).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(answers).toHaveLength(2));
    expect((screen.getByRole('button', { name: 'Decline the invitation to Moon' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true);

    // A second click on a pending invitation sends nothing.
    fireEvent.click(acceptMoon);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);

    // Mars answers first: Moon stays locked.
    await act(async () => answers[1]());
    await waitFor(() => expect(screen.queryByText('Mars')).toBeNull());
    expect((screen.getByRole('button', { name: 'Decline the invitation to Moon' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answers[0]());
    await waitFor(() => expect(screen.queryByTestId('invitations')).toBeNull());
    // Signed in once; each answer reloaded the lists once.
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/memberships/invitations')).toHaveLength(3);
  });

  const universe = {
    universe: { id: 'u1', name: 'BAWES', worlds: [{ id: 'hq', name: 'HQ' }, { id: 'campus', name: 'Campus' }] },
    isOwner: false,
    joinedAt: '2026-10-01T00:00:00Z',
    worlds: { allWorlds: true, worldIds: [] },
    roles: [
      { key: 'accountant', name: 'Accountant', color: '#34D399', allWorlds: true, worldIds: [] },
      { key: 'editor', name: 'Editor', color: '#60A5FA', allWorlds: false, worldIds: ['hq'] },
    ],
  };

  it('lists your universes with your roles there and where each works, and says you join a universe once', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: [] });
      if (url === '/api/memberships/my/universes') return json({ universes: [universe, { ...universe, universe: { ...universe.universe, id: 'u2', name: 'Mine' }, isOwner: true, roles: [] }] });
      return json({});
    });
    render(<MyMembershipsPage />);
    const row = (await screen.findByText('BAWES')).closest('div[class*="row"]') as HTMLElement;
    expect(row.textContent).toContain('HQ and Campus');
    expect(row.textContent).toContain('Joined Oct 2026');
    expect(row.textContent).toContain('Accountant');
    expect(row.textContent).toContain('Editor');
    expect(row.textContent).toContain('HQ only');
    expect(screen.getByText(/You join a universe once/)).toBeTruthy();
    // The owner has no one to ask: no Leave on a universe you own
    expect(screen.getAllByRole('button', { name: /^Leave / })).toHaveLength(1);
  });

  it('puts the universes you joined under Member of first and the ones you own under You own, saying Owner once', async () => {
    const mine = {
      ...universe,
      universe: { ...universe.universe, id: 'u2', name: 'Mine', createdAt: '2025-12-01T00:00:00Z' },
      isOwner: true,
      // Joined when the first world was made, and only into HQ: the row still says when the universe was made, and every world.
      joinedAt: '2026-02-01T00:00:00Z',
      worlds: { allWorlds: false, worldIds: ['hq'] },
      // An owner keeps roles from before; the heading already says what they are there.
      roles: [{ key: 'admin', name: 'Admin', color: '#F87171', allWorlds: false, worldIds: ['hq'] }],
    };
    const empty = { ...mine, universe: { id: 'u3', name: 'Empty', createdAt: '2025-12-01T00:00:00Z', worlds: [] }, roles: [] };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: [] });
      if (url === '/api/memberships/my/universes') return json({ universes: [mine, universe, empty] });
      return json({});
    });
    render(<MyMembershipsPage />);
    const joined = await screen.findByTestId('joined-universes');
    const owned = screen.getByTestId('owned-universes');
    expect(joined.compareDocumentPosition(owned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(joined.querySelector('h2')?.textContent).toBe('Member of1');
    expect(owned.querySelector('h2')?.textContent).toBe('You own2');
    expect(joined.textContent).toContain('BAWES');
    expect(joined.textContent).toContain('Joined Oct 2026');

    const ownedText = owned.textContent ?? '';
    expect(ownedText).toContain('Mine');
    expect(ownedText).toContain('HQ and Campus');
    expect(ownedText).toContain('Created Dec 2025');
    expect(ownedText).toContain('No worlds yet');
    expect(ownedText).not.toContain('Owner');
    expect(ownedText).not.toContain('Admin');
    expect(ownedText).not.toContain('Joined');
    expect(ownedText).not.toContain('Feb 2026');
    // The page lists only universes, so no row repeats the word.
    expect(screen.queryByText(/^Universe$/)).toBeNull();
    expect(document.body.textContent).not.toContain('Universe ·');
  });

  it('says where a role works only when that differs from the worlds you are in', async () => {
    const limited = {
      ...universe,
      worlds: { allWorlds: false, worldIds: ['hq'] },
      roles: [{ key: 'admin', name: 'Admin', color: '#F87171', allWorlds: false, worldIds: ['hq'] }],
    };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: [] });
      if (url === '/api/memberships/my/universes') return json({ universes: [limited] });
      return json({});
    });
    render(<MyMembershipsPage />);
    const joined = await screen.findByTestId('joined-universes');
    expect(joined.textContent).toContain('Admin');
    expect(joined.textContent).toContain('HQ');
    expect(joined.textContent).not.toContain('HQ only');
  });

  it('asks before leaving, with Cancel as the way out, then leaves the universe and reloads', async () => {
    let left = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: [] });
      if (url === '/api/memberships/my/universes') return json({ universes: left ? [] : [universe] });
      if (url === '/api/admin/universes/u1/members/me' && init?.method === 'DELETE') {
        left = true;
        return json({ success: true });
      }
      return json({});
    });
    render(<MyMembershipsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave BAWES' }));
    expect(await screen.findByText('Leave BAWES?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Leave BAWES?')).toBeNull());
    expect(left).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Leave BAWES' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Leave')!);
    await screen.findByText('No memberships yet.');
    expect(left).toBe(true);
  });
  it('shows a universe invitation as the universe, the worlds it gives and its roles, and an older one as its world', async () => {
    const toUniverse = (id: string, scope: { allWorlds: boolean; worldIds: string[] }, roles: { id: string; name: string; color: string }[]) => ({
      ...invitation(id, 'HQ'),
      world: { id: 'hq', name: 'HQ', slug: 'hq', universe: { id: 'u', name: 'BAWES', slug: 'bawes' } },
      tags: [],
      universeId: 'u',
      ...scope,
      roles,
    });
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations')
        return json({
          invitations: [
            toUniverse('i1', { allWorlds: true, worldIds: [] }, [{ id: 'r-admin', name: 'Admin', color: '#F87171' }]),
            toUniverse('i2', { allWorlds: false, worldIds: ['hq'] }, []),
            toUniverse('i3', { allWorlds: false, worldIds: ['hq', 'campus', 'lab'] }, []),
            invitation('i4', 'Moon'),
          ],
        });
      if (url === '/api/memberships/my/universes') return json({ universes: [] });
      return json({});
    });
    render(<MyMembershipsPage />);
    const list = await screen.findByTestId('invitations');
    const text = list.textContent ?? '';
    // Every world, as Admin: never "HQ" with no roles
    expect(screen.getAllByText('BAWES')).toHaveLength(3);
    expect(screen.getByText('Khalid invited you · Every world')).toBeTruthy();
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.getByText('Khalid invited you · HQ only')).toBeTruthy();
    expect(screen.getByText('Khalid invited you · 3 worlds')).toBeTruthy();
    expect(screen.getAllByText('Member')).toHaveLength(2);
    // An older world invitation still names its world and tags
    expect(screen.getByText('Moon')).toBeTruthy();
    expect(text).toContain('Khalid invited you as member');
    expect(screen.getAllByRole('button', { name: 'Decline the invitation to BAWES' })).toHaveLength(3);
  });

  it('says which roles an accepted invitation could not give, and why', async () => {
    let remaining = [invitation('i1', 'Moon')];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return json({ user: { id: 'me' } });
      if (url === '/api/memberships/invitations') return json({ invitations: remaining });
      if (url === '/api/memberships/my/universes') return json({ universes: [] });
      if (init?.method === 'POST') {
        remaining = [];
        return json({ member: null, rolesNotGiven: ['Boss'] });
      }
      return json({});
    });
    render(<MyMembershipsPage />);
    await screen.findByTestId('invitations');
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toBe(
      'You joined without Boss. A role with Administrator works in every world, so it can’t come with an invitation to some worlds. Ask an Admin of Uni to give it to you.',
    );
  });
});
