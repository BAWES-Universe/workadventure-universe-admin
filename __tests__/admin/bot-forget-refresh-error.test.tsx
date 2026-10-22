/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BotDetailPage from '@/app/admin/bots/[id]/page';
import { authenticatedFetch } from '@/lib/client-auth';

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: jest.fn() }));
jest.mock('next/navigation', () => {
  const router = { push: jest.fn(), replace: jest.fn() };
  return { useRouter: () => router };
});
jest.mock('recharts', () => new Proxy({}, { get: () => () => null }));
jest.mock('@/components/bot-texture-picker', () => () => null);

const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const hiddenPrivacy = {
  universeHides: true,
  choice: 'follow',
  hidden: true,
  people: 1,
  lastUpdated: 1,
  replies: 3,
  remembered: [{ id: 7, name: 'Sam', isGuest: false, updatedAt: 1 }],
};

const bot = {
  id: 'bot-a',
  name: 'Rex',
  description: null,
  characterTextureId: null,
  enabled: true,
  behaviorType: 'idle',
  behaviorConfig: {},
  aiProviderRef: null,
  createdAt: '2026-10-01T00:00:00Z',
  room: {
    id: 'r',
    name: 'Lobby',
    slug: 'lobby',
    world: { id: 'w', name: 'Home', slug: 'home', universe: { id: 'u', name: 'Universe', slug: 'u' } },
  },
  createdBy: { id: 'c', name: 'Kay' },
  updatedBy: null,
};

describe('Forget on a bot with telemetry off', () => {
  it('shows the retry state, not the forgotten person, when the refresh after Forget fails', async () => {
    let privacyCalls = 0;
    (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { isSuperAdmin: true } });
      if (url === '/api/bots/bot-a/privacy') {
        privacyCalls += 1;
        return privacyCalls === 1 ? json(hiddenPrivacy) : Promise.reject(new Error('offline'));
      }
      if (url === '/api/bots/bot-a/forget') return json({ ok: true });
      if (url.startsWith('/api/admin/bots/bot-a?')) return json({ bot, usage: [], stats: null, botExists: true });
      return json({}, false, 500);
    });

    const params = Promise.resolve({ id: 'bot-a' });
    await act(async () => {
      render(<BotDetailPage params={params} />);
    });
    await act(async () => {
      fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Emotions' }), { button: 0 });
      fireEvent.click(await screen.findByRole('tab', { name: 'Emotions' }));
    });

    expect(await screen.findByText('Sam')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget', hidden: false }));
    await waitFor(() => expect(privacyCalls).toBe(2));

    expect(await screen.findByText('We couldn’t load emotions.')).toBeInTheDocument();
    expect(screen.queryByText('Sam')).not.toBeInTheDocument();
  });
});
