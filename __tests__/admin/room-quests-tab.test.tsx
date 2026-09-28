/** @jest-environment jsdom */

/**
 * The room page's Quests tab: only with the quests proof slice on and only for those who can edit the room; it keeps
 * its place in the address so Back from a quest page lands on it.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import RoomDetailPage from '@/app/admin/rooms/[id]/page';
import { WorkAdventureContext } from '@/app/admin/workadventure-context';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: 'r-1' }),
}));
jest.mock('@/components/templates/TemplateLibrary', () => ({ TemplateLibrary: () => null }));
jest.mock('@/components/templates/TemplateDetail', () => ({ TemplateDetail: () => null }));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const respond = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function route(canEdit: boolean) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/auth/me') return respond({ user: { id: 'u-1', isSuperAdmin: false } });
    if (url === '/api/admin/rooms/r-1') {
      return respond({
        id: 'r-1',
        slug: 'lobby',
        name: 'Lobby',
        description: null,
        mapUrl: null,
        wamUrl: null,
        templateMapId: null,
        isPublic: true,
        canEdit,
        world: { id: 'w-1', name: 'Office', slug: 'office', universe: { id: 'u-1', name: 'BAWES', slug: 'bawes' } },
      });
    }
    return respond({});
  });
}

function renderPage() {
  render(
    <WorkAdventureContext.Provider value={{ wa: null, isReady: false, isLoading: false, error: null, navigateToRoom: jest.fn() }}>
      <RoomDetailPage />
    </WorkAdventureContext.Provider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/admin/rooms/r-1');
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE;
});

it('has no Quests tab while the slice is off', async () => {
  route(true);
  renderPage();
  expect(await screen.findByRole('button', { name: 'Visitors' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Quests' })).toBeNull();
});

it('has no Quests tab for someone who cannot edit the room', async () => {
  process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE = 'true';
  route(false);
  renderPage();
  expect(await screen.findByRole('button', { name: 'Visitors' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Quests' })).toBeNull();
});

it('shows the Quests tab to an editor and keeps it in the address', async () => {
  process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE = 'true';
  route(true);
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Quests' }));
  expect(await screen.findByTestId('room-quests-empty')).toBeTruthy();
  expect(window.location.search).toBe('?tab=quests');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(window.location.search).toBe('');
});

it('opens on the Quests tab when the address says so', async () => {
  process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE = 'true';
  window.history.replaceState(null, '', '/admin/rooms/r-1?tab=quests');
  route(true);
  renderPage();
  expect(await screen.findByTestId('room-quests')).toBeTruthy();
});
