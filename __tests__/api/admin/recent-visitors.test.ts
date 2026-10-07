import { NextRequest } from 'next/server';
import { GET as getVisitors } from '@/app/api/admin/recent-visitors/route';
import { GET as getPassport } from '@/app/api/admin/users/[id]/passport/route';
import { getViewer } from '@/lib/access-scope';
import { loadRecentVisitors } from '@/lib/recent-visitors';
import { visibleStamps } from '@/lib/passport';

jest.mock('@/lib/access-scope', () => ({
  getViewer: jest.fn(),
  viewerUserId: (viewer: { kind: string; user?: { id: string } } | null) => (viewer?.kind === 'user' ? viewer.user!.id : null),
  unauthorizedResponse: () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
jest.mock('@/lib/recent-visitors', () => ({ loadRecentVisitors: jest.fn() }));
jest.mock('@/lib/passport', () => ({ CARD_STAMPS: 3, visibleStamps: jest.fn() }));

const viewer = { kind: 'user', user: { id: 'me' } };
const get = (query: string) => new NextRequest(`http://localhost:3333/api/admin/recent-visitors${query}`);

beforeEach(() => {
  jest.resetAllMocks();
  (getViewer as jest.Mock).mockResolvedValue(viewer);
});

describe('/api/admin/recent-visitors', () => {
  it('turns the scope and id into the place to look at', async () => {
    (loadRecentVisitors as jest.Mock).mockResolvedValue([]);
    for (const [scope, key] of [['universe', 'universeId'], ['world', 'worldId'], ['room', 'roomId']]) {
      expect((await getVisitors(get(`?scope=${scope}&id=abc`))).status).toBe(200);
      expect((loadRecentVisitors as jest.Mock).mock.calls.at(-1)).toEqual([viewer, { [key]: 'abc' }]);
    }
  });

  it('wants someone signed in, a known scope and an id', async () => {
    expect((await getVisitors(get('?scope=room&id=abc'))).status).toBe(200);
    (getViewer as jest.Mock).mockResolvedValue(null);
    expect((await getVisitors(get('?scope=room&id=abc'))).status).toBe(401);
    (getViewer as jest.Mock).mockResolvedValue(viewer);
    expect((await getVisitors(get('?scope=planet&id=abc'))).status).toBe(400);
    expect((await getVisitors(get('?scope=room'))).status).toBe(400);
    expect((await getVisitors(get('?scope=toString&id=abc'))).status).toBe(400);
  });

  it('answers 500 when it cannot load', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (loadRecentVisitors as jest.Mock).mockRejectedValue(new Error('db'));
    expect((await getVisitors(get('?scope=room&id=abc'))).status).toBe(500);
  });
});

describe('/api/admin/users/[id]/passport', () => {
  const call = () => getPassport(new NextRequest('http://localhost:3333/api/admin/users/sara/passport'), { params: Promise.resolve({ id: 'sara' }) });

  it('gives the stamps this viewer may see', async () => {
    (visibleStamps as jest.Mock).mockResolvedValue([{ worldId: 'hq' }]);
    const response = await call();
    expect(await response.json()).toEqual({ stamps: [{ worldId: 'hq' }] });
    expect(visibleStamps).toHaveBeenCalledWith('me', 'sara', 3);
  });

  it('wants someone signed in', async () => {
    (getViewer as jest.Mock).mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(visibleStamps).not.toHaveBeenCalled();
  });
});
