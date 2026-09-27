/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The avatar set's access check lists people and worlds: each body is read once, and a failed load says so with a
 * retry instead of "Loading…" for good.
 */

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'set-1' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import AvatarSetPage from '@/app/admin/avatars/[id]/page';

const SET = {
  id: 'set-1',
  name: 'Starter set',
  slug: 'starter',
  description: null,
  kind: 'standard',
  visibility: 'public',
  lifecycle: 'active',
  position: 0,
  availableFrom: null,
  availableUntil: null,
  layers: [],
  scopes: [],
};
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const fail = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });

function route(lists: 'ok' | 'fail') {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/auth/me') return ok({ user: { id: 'me' } });
    if (url.startsWith('/api/admin/avatar-sets/set-1')) return ok(SET);
    if (url.startsWith('/api/admin/users')) return lists === 'ok' ? ok({ users: [{ id: 'u1', name: 'Khalid', email: 'k@x.test', uuid: 'uu1' }] }) : fail();
    if (url.startsWith('/api/admin/worlds')) return lists === 'ok' ? ok({ worlds: [{ id: 'w1', name: 'Studio', slug: 'studio', universe: { name: 'BAWES' } }] }) : fail();
    return ok({});
  });
}

async function openAccessTab() {
  const tab = await screen.findByRole('tab', { name: 'Access check' });
  fireEvent.mouseDown(tab, { button: 0 });
}

beforeEach(() => fetchMock.mockReset());

describe('Avatar set access check', () => {
  it('lists the people and worlds it loaded', async () => {
    route('ok');
    render(<AvatarSetPage />);
    await openAccessTab();
    expect(await screen.findByRole('button', { name: /Khalid/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Studio/ })).toBeTruthy();
    expect(screen.queryByText(/Loading people/)).toBeNull();
  });

  it('says a failed load failed, and Try again loads them', async () => {
    route('fail');
    render(<AvatarSetPage />);
    await openAccessTab();
    const retry = await screen.findByRole('button', { name: /try again/i });
    expect(screen.queryByText(/Loading people/)).toBeNull();

    route('ok');
    fireEvent.click(retry);
    expect(await screen.findByRole('button', { name: /Khalid/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /try again/i })).toBeNull());
  });
});
