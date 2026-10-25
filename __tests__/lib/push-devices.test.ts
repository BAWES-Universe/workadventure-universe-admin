import { Prisma } from '@prisma/client';
import { MAX_PUSH_DEVICES, deviceLabel, isPushEndpoint, readPushDeviceInput, registerPushDevice } from '@/lib/push-devices';
import { prisma } from '@/lib/db';

type Row = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  enabled: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  lastNotifiedAt: Date | null;
};
const rows: Row[] = [];
let nextId = 1;

jest.mock('@/lib/db', () => ({
  prisma: {
    pushDevice: {
      findUnique: jest.fn(async ({ where }: { where: { endpoint: string } }) => rows.find((row) => row.endpoint === where.endpoint) ?? null),
      upsert: jest.fn(async ({ where, create, update }: { where: { endpoint: string }; create: Partial<Row>; update: Partial<Row> }) => {
        const row = rows.find((item) => item.endpoint === where.endpoint);
        if (row) return Object.assign(row, update);
        const created = { id: `d${nextId++}`, enabled: true, createdAt: new Date(), lastNotifiedAt: null, ...create } as Row;
        rows.push(created);
        return created;
      }),
      findMany: jest.fn(async ({ where, skip }: { where: { userId: string }; skip: number }) =>
        rows.filter((row) => row.userId === where.userId)
          .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
          .slice(skip)),
      deleteMany: jest.fn(async ({ where }: { where: { userId: string; id: { in: string[] } } }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].userId === where.userId && where.id.in.includes(rows[i].id)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  },
}));

const P256DH = 'B' + 'A'.repeat(86);
const AUTH = 'a'.repeat(22);
const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH }, label: 'Chrome on Android' });

describe('push devices', () => {
  beforeEach(() => {
    rows.length = 0;
    nextId = 1;
    jest.clearAllMocks();
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
  ])('keeps the push service of a main browser: %s', (endpoint) => {
    expect(isPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/abc',
    'https://evil.example.com/abc',
    'https://fcm.googleapis.com.evil.example/abc',
    'https://notify.windows.com.evil.example/abc',
    'https://user:pw@fcm.googleapis.com/abc',
    'not a url',
  ])('refuses any other address, since Orbit sends to it: %s', (endpoint) => {
    expect(isPushEndpoint(endpoint)).toBe(false);
  });

  it('reads a browser subscription, and refuses keys of the wrong shape', () => {
    expect(readPushDeviceInput(subscription())).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: P256DH,
      auth: AUTH,
      label: 'Chrome on Android',
    });
    expect(readPushDeviceInput({ ...subscription(), keys: { p256dh: 'short', auth: AUTH } })).toBeNull();
    expect(readPushDeviceInput({ ...subscription(), keys: { p256dh: P256DH, auth: 'has spaces in it!!' } })).toBeNull();
    expect(readPushDeviceInput({ endpoint: subscription().endpoint })).toBeNull();
  });

  it('keeps a device name to one plain line', () => {
    expect(deviceLabel('  Chrome\non   Mac  ')).toBe('Chrome on Mac');
    expect(deviceLabel('x'.repeat(80))).toHaveLength(60);
    expect(deviceLabel(undefined)).toBe('This browser');
  });

  it('keeps its own switch when the same person registers again', async () => {
    const first = await registerPushDevice('user-a', readPushDeviceInput(subscription())!);
    rows[0].enabled = false;
    const again = await registerPushDevice('user-a', readPushDeviceInput(subscription())!);
    expect(again.id).toBe(first.id);
    expect(again.enabled).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it('moves a browser to whoever signs in on it, switched on and with a fresh history', async () => {
    await registerPushDevice('user-a', readPushDeviceInput(subscription())!);
    rows[0].enabled = false;
    rows[0].lastNotifiedAt = new Date();
    const moved = await registerPushDevice('user-b', readPushDeviceInput(subscription())!);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('user-b');
    expect(moved).toMatchObject({ enabled: true, lastNotifiedAt: null });
  });

  it('drops the devices not seen for longest beyond the limit', async () => {
    for (let i = 0; i < MAX_PUSH_DEVICES; i++) {
      rows.push({
        id: `old${i}`, userId: 'user-a', endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, p256dh: P256DH, auth: AUTH,
        label: 'x', enabled: true, createdAt: new Date(0), lastSeenAt: new Date(1000 + i), lastNotifiedAt: null,
      });
    }
    await registerPushDevice('user-a', readPushDeviceInput(subscription('https://fcm.googleapis.com/fcm/send/new'))!);
    expect(rows).toHaveLength(MAX_PUSH_DEVICES);
    expect(rows.some((row) => row.id === 'old0')).toBe(false);
    expect(rows.some((row) => row.endpoint.endsWith('/new'))).toBe(true);
  });

  it('tries once more when another tab registered the same new browser at the same moment', async () => {
    const upsert = prisma.pushDevice.upsert as jest.Mock;
    upsert.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }));
    const device = await registerPushDevice('user-a', readPushDeviceInput(subscription())!);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(device.label).toBe('Chrome on Android');
  });
});
