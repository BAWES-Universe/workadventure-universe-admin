/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UniverseDetailPage } from '@/app/admin/universes/[id]/detail';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'u1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock('@/app/admin/orbit-frame-context', () => ({ useReplacePage: () => jest.fn() }));
jest.mock('@/app/admin/admin-bootstrap-context', () => ({ useIsSuperAdmin: () => false }));
jest.mock('@/app/admin/hooks/use-entity-summaries', () => ({ useEntitySummaries: () => ({ summary: () => null, state: () => ({ status: 'loading' }), retry: jest.fn() }) }));
jest.mock('@/app/admin/hooks/use-place-data', () => ({
  useHere: () => ({ here: [], known: false, byRoom: {} }),
  useStarToggle: () => ({ toggle: jest.fn(), busy: false }),
  useUniverseRank: () => null,
  useWorldRooms: () => ({}),
}));
jest.mock('@/app/admin/components/recent-visitors', () => () => null);
jest.mock('@/app/admin/components/universe-members-row', () => () => null);
jest.mock('@/app/admin/components/visitor-people', () => ({ VisitorPeople: () => null }));

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
let stored = true;
let patches: Record<string, unknown>[] = [];

function universe() {
  return {
    id: 'u1', slug: 'u', name: 'Test universe', description: null, thumbnailUrl: null, isPublic: true, featured: false,
    ownerId: 'owner', owner: { id: 'owner', name: 'Khalid', woka: [] }, createdAt: '2026-01-01T00:00:00Z',
    canEdit: true, worlds: [], hideBotConversations: stored,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  patches = [];
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/auth/me') return ok({ user: { id: 'owner' } });
    if (url === '/api/admin/universes/u1' && init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string);
      patches.push(body);
      stored = body.hideBotConversations;
      return ok(universe());
    }
    if (url === '/api/admin/universes/u1') return ok(universe());
    return ok({});
  });
});

async function openEdit() {
  render(<UniverseDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
  return screen.findByRole('switch', { name: 'Hide bot conversations' });
}

test('asks before switching Hide bot conversations off, and saves only after Save', async () => {
  stored = true;
  const toggle = await openEdit();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  expect(await screen.findByText('Show bot conversations again?')).toBeInTheDocument();
  expect(screen.getByText(/Saved conversations will show again/)).toBeInTheDocument();
  expect(patches).toHaveLength(0);
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).pop() as HTMLElement);
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].hideBotConversations).toBe(false);
});

test('Cancel in the question saves nothing', async () => {
  stored = true;
  const toggle = await openEdit();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await screen.findByText('Show bot conversations again?');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(patches).toHaveLength(0);
});

test('does not ask when switching on, or when it was already off', async () => {
  stored = false;
  const toggle = await openEdit();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(screen.queryByText('Show bot conversations again?')).not.toBeInTheDocument();
  expect(patches[0].hideBotConversations).toBe(true);
});

test('does not ask when saving other changes with the setting left on', async () => {
  stored = true;
  await openEdit();
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(screen.queryByText('Show bot conversations again?')).not.toBeInTheDocument();
  expect(patches[0].hideBotConversations).toBe(true);
});
