import { NextRequest } from 'next/server';
import { POST as pusher } from '@/app/api/me/push/devices/[id]/pusher/route';
import { POST as activity } from '@/app/api/me/push/activity/route';
import { POST as notify } from '@/app/%5Fmatrix/push/v1/notify/route';
import { getSessionUser } from '@/lib/auth-session';
import { recordActivity } from '@/lib/push-activity';
import { handleGatewayNotification } from '@/lib/push-gateway';
import { prisma } from '@/lib/db';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/push-activity', () => ({ ...jest.requireActual('@/lib/push-activity'), recordActivity: jest.fn() }));
jest.mock('@/lib/push-gateway', () => ({ ...jest.requireActual('@/lib/push-gateway'), handleGatewayNotification: jest.fn() }));

const rows: { id: string; userId: string; label: string; gatewaySecret: string | null }[] = [];
jest.mock('@/lib/db', () => ({
  prisma: {
    pushDevice: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; gatewaySecret: null }; data: { gatewaySecret: string } }) => {
        const row = rows.find((item) => item.id === where.id && item.gatewaySecret === null);
        if (row) row.gatewaySecret = data.gatewaySecret;
        return { count: row ? 1 : 0 };
      }),
    },
  },
}));

const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (url: string, body?: unknown) =>
  new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

describe('direct message notification routes', () => {
  const savedUrl = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    rows.length = 0;
    rows.push({ id: 'd1', userId: 'user-a', label: 'Chrome on Android', gatewaySecret: null });
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.example.com';
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_API_URL = savedUrl;
  });

  it('hands the game the pusher for Synapse: Orbit’s gateway and a secret that stays the same', async () => {
    const first = await (await pusher(request('http://localhost/api/me/push/devices/d1/pusher'), params('d1'))).json();
    expect(first.pusher).toMatchObject({
      kind: 'http',
      app_id: 'net.bawes.universe.web',
      pushkey: 'd1',
      device_display_name: 'Chrome on Android',
      data: { url: 'https://orbit.example.com/_matrix/push/v1/notify' },
    });
    expect(first.pusher.data.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = await (await pusher(request('http://localhost/api/me/push/devices/d1/pusher'), params('d1'))).json();
    expect(second.pusher.data.secret).toBe(first.pusher.data.secret);
    expect(prisma.pushDevice.updateMany).toHaveBeenCalledTimes(1);
  });

  it('gives no pusher for someone else’s device, or when signed out', async () => {
    rows[0].userId = 'user-b';
    expect((await pusher(request('http://localhost/api/me/push/devices/d1/pusher'), params('d1'))).status).toBe(404);
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await pusher(request('http://localhost/api/me/push/devices/d1/pusher'), params('d1'))).status).toBe(401);
  });

  it('records where the caller is, and refuses a report of the wrong shape', async () => {
    const report = { tabId: 'tab-12345', front: true, chatRoomId: '!dm:chat' };
    expect((await activity(request('http://localhost/api/me/push/activity', report))).status).toBe(200);
    expect(recordActivity).toHaveBeenCalledWith('user-a', report);
    expect((await activity(request('http://localhost/api/me/push/activity', { front: true }))).status).toBe(400);
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await activity(request('http://localhost/api/me/push/activity', report))).status).toBe(401);
  });

  it('answers Synapse with the pushkeys to drop, and in Matrix errors otherwise', async () => {
    (handleGatewayNotification as jest.Mock).mockResolvedValueOnce({ rejected: ['gone'] }).mockResolvedValueOnce(null);
    const ok = await notify(request('http://localhost/_matrix/push/v1/notify', { notification: { devices: [] } }));
    expect(await ok.json()).toEqual({ rejected: ['gone'] });
    expect((await notify(request('http://localhost/_matrix/push/v1/notify', { other: 1 }))).status).toBe(400);
    expect(await (await notify(request('http://localhost/_matrix/push/v1/notify', 'not json'))).json()).toMatchObject({ errcode: 'M_NOT_JSON' });
  });
});
