/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UniverseDetailPage } from '@/app/admin/universes/[id]/detail';

/**
 * Visiting Bricks (game #2005): one switch per universe in Edit universe, under Visibility, with the words of the mock
 * (Part 15, picture 9). A universe that exists today starts with it off; saving sends what the form shows.
 */
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
let stored: boolean | undefined = false;
let patches: Record<string, unknown>[] = [];

const universe = () => ({
  id: 'u1', slug: 'u', name: 'Test universe', description: null, thumbnailUrl: null, isPublic: true, featured: false,
  ownerId: 'owner', owner: { id: 'owner', name: 'Khalid', woka: [] }, createdAt: '2026-01-01T00:00:00Z',
  canEdit: true, worlds: [], hideBotConversations: false, ...(stored === undefined ? {} : { allowVisitingBricks: stored }),
});

beforeEach(() => {
  jest.clearAllMocks();
  patches = [];
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/auth/me') return ok({ user: { id: 'owner' } });
    if (url === '/api/admin/universes/u1' && init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string);
      patches.push(body);
      stored = body.allowVisitingBricks;
      return ok(universe());
    }
    if (url === '/api/admin/universes/u1') return ok(universe());
    return ok({});
  });
});

const openEdit = async () => {
  render(<UniverseDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
  return screen.findByRole('switch', { name: 'Visiting Bricks' });
};

test('shows the switch off for a universe that exists today, with the mock’s words', async () => {
  stored = false;
  const toggle = await openEdit();
  expect(toggle).not.toBeChecked();
  expect(screen.getByText('People can bring their own Brick along. It walks beside them and anyone here can talk to it. Off: their Brick still answers them in direct messages.')).toBeInTheDocument();
});

test('turning it on is saved by Save and sends exactly what the form shows', async () => {
  stored = false;
  const toggle = await openEdit();
  fireEvent.click(toggle);
  expect(patches).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].allowVisitingBricks).toBe(true);
});

test('saving other changes sends the switch as it was', async () => {
  stored = false;
  await openEdit();
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].allowVisitingBricks).toBe(false);
});

test('a universe that never says shows it on, as a universe made today starts', async () => {
  stored = undefined;
  expect(await openEdit()).toBeChecked();
});
