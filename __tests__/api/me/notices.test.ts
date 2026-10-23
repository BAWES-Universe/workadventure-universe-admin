import { NextRequest } from 'next/server';
import { GET, OPTIONS } from '@/app/api/me/notices/route';
import { DELETE } from '@/app/api/me/notices/[id]/route';
import { getSessionUser } from '@/lib/auth-session';
import { dismissNotice, openNotices } from '@/lib/notices';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/notices', () => ({ openNotices: jest.fn(), dismissNotice: jest.fn() }));

const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };
const row = { id: 'n1', userId: 'user-a', kind: 'ai-key-down', dedupeKey: 'secret-dedupe', title: 'My LM Studio is down', body: 'Guide and Nora reply on Universe AI.', badge: 'Down', href: '/admin/you/ai-keys', createdAt: new Date('2026-10-19T11:00:00Z'), dismissedAt: null };
const get = (headers: Record<string, string> = {}) => GET(new NextRequest('http://localhost:3333/api/me/notices', { headers }));
const del = (id = 'n1', headers: Record<string, string> = {}) =>
  DELETE(new NextRequest(`http://localhost:3333/api/me/notices/${id}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
});

describe('GET /api/me/notices', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(openNotices).not.toHaveBeenCalled();
  });

  it('answers with the caller’s open notices, without the internal key', async () => {
    (openNotices as jest.Mock).mockResolvedValue([row]);
    const response = await get();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(openNotices).toHaveBeenCalledWith('user-a');
    expect(await response.json()).toEqual({
      notices: [{ id: 'n1', kind: 'ai-key-down', title: 'My LM Studio is down', body: 'Guide and Nora reply on Universe AI.', badge: 'Down', href: '/admin/you/ai-keys', createdAt: '2026-10-19T11:00:00.000Z' }],
    });
  });

  it('refuses another origin, and never answers with *', async () => {
    const response = await get({ origin: 'https://evil.example.com' });
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await OPTIONS(new NextRequest('http://localhost:3333/api/me/notices', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }))).status).toBe(403);
  });

  it('says so with a 500 when it cannot read', async () => {
    (openNotices as jest.Mock).mockRejectedValue(new Error('db down'));
    expect((await get()).status).toBe(500);
  });
});

describe('DELETE /api/me/notices/:id', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await del()).status).toBe(401);
    expect(dismissNotice).not.toHaveBeenCalled();
  });

  it('dismisses the caller’s own notice', async () => {
    (dismissNotice as jest.Mock).mockResolvedValue(true);
    const response = await del('n1');
    expect(response.status).toBe(200);
    expect(dismissNotice).toHaveBeenCalledWith('user-a', 'n1');
  });

  it('answers 404 for someone else’s notice or one already dismissed', async () => {
    (dismissNotice as jest.Mock).mockResolvedValue(false);
    expect((await del('n9')).status).toBe(404);
  });

  it('refuses another origin', async () => {
    expect((await del('n1', { origin: 'https://evil.example.com' })).status).toBe(403);
    expect(dismissNotice).not.toHaveBeenCalled();
  });
});
