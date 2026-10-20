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

/** Open Edit, then Advanced settings (collapsed when the form opens), and give back the telemetry switch. */
async function openEdit() {
  render(<UniverseDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Advanced settings' }));
  return screen.findByRole('switch', { name: 'Bot chat telemetry' });
}

test('Advanced settings is collapsed when Edit opens, and holds the one row, which is not a Bots group', async () => {
  stored = false;
  render(<UniverseDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
  const head = await screen.findByRole('button', { name: 'Advanced settings' });
  expect(head).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('switch', { name: 'Bot chat telemetry' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Hide bot conversations/)).not.toBeInTheDocument();
  fireEvent.click(head);
  expect(await screen.findByRole('switch', { name: 'Bot chat telemetry' })).toBeChecked();
  expect(screen.getByText(/Helps us find and fix bots that misbehave/)).toBeInTheDocument();
});

test('turning it off asks nothing and is saved by Save', async () => {
  stored = false;
  const toggle = await openEdit();
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(screen.queryByText('Turn bot chat telemetry on?')).not.toBeInTheDocument();
  expect(patches).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].hideBotConversations).toBe(true);
});

test('turning it back on asks once, with the exact words, and only Turn on changes the setting', async () => {
  stored = true;
  const toggle = await openEdit();
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(await screen.findByText('Turn bot chat telemetry on?')).toBeInTheDocument();
  expect(screen.getByText(/Chats with bots in Test universe go to analytics and error reports again\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('switch', { name: 'Bot chat telemetry' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('switch', { name: 'Bot chat telemetry' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Bot chat telemetry' })).toBeChecked());
  expect(patches).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0].hideBotConversations).toBe(false);
});

test('saving other changes with the setting left alone sends it unchanged and asks nothing', async () => {
  stored = true;
  render(<UniverseDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Save/ }));
  await waitFor(() => expect(patches).toHaveLength(1));
  expect(screen.queryByText('Turn bot chat telemetry on?')).not.toBeInTheDocument();
  expect(patches[0].hideBotConversations).toBe(true);
});

test('"What\'s sent" opens the popup with the approved words and Close', async () => {
  stored = false;
  await openEdit();
  fireEvent.click(screen.getByRole('button', { name: 'What’s sent' }));
  expect(await screen.findByText('Bots always save their chats and remember people the same way. This only decides where the chat text goes.')).toBeInTheDocument();
  expect(screen.getByText('Bot chats go to our analytics and error reports, so we can find and fix bots that misbehave.')).toBeInTheDocument();
  expect(screen.getByText('Chats stay saved in our database, which only the Universe team can open.')).toBeInTheDocument();
  expect(screen.getByText('Chats between people are never part of this.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByText('Chats between people are never part of this.')).not.toBeInTheDocument());
});
