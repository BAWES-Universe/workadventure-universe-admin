import webpush, { WebPushError } from 'web-push';
import { inQuietHours, pushTopic, sendPush, sendPushOnceADay } from '@/lib/push';
import { DEFAULT_PUSH_SETTINGS, getPushSettings } from '@/lib/push-settings';
import { prisma } from '@/lib/db';

jest.mock('web-push', () => {
  class WebPushError extends Error {
    constructor(message: string, readonly statusCode: number) {
      super(message);
    }
  }
  return { __esModule: true, default: { sendNotification: jest.fn() }, WebPushError };
});
jest.mock('@/lib/push-settings', () => ({
  ...jest.requireActual('@/lib/push-settings'),
  getPushSettings: jest.fn(),
}));
jest.mock('@/lib/db', () => ({
  prisma: {
    pushDevice: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

const send = webpush.sendNotification as jest.Mock;
const devices = [
  { id: 'd1', endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'p1', auth: 'a1' },
  { id: 'd2', endpoint: 'https://web.push.apple.com/2', p256dh: 'p2', auth: 'a2' },
];
const message = { title: 'Ali', body: 'wants to be friends', tag: 'friend-request:uuid-ali' };

describe('sending a notification', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAPID_PUBLIC_KEY = 'B' + 'x'.repeat(86);
    process.env.VAPID_PRIVATE_KEY = 'private';
    process.env.VAPID_SUBJECT = 'mailto:team@example.com';
    (getPushSettings as jest.Mock).mockResolvedValue(DEFAULT_PUSH_SETTINGS);
    (prisma.pushDevice.findMany as jest.Mock).mockResolvedValue(devices);
    send.mockResolvedValue({ statusCode: 201 });
  });

  afterAll(() => {
    process.env = env;
  });

  it('sends the title and line to every switched-on device, one topic per tag, and notes when', async () => {
    expect(await sendPush('user-a', 'friendRequests', message)).toBe(2);

    expect(prisma.pushDevice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a', enabled: true } }));
    expect(send).toHaveBeenCalledTimes(2);
    const [subscription, payload, options] = send.mock.calls[0];
    expect(subscription).toEqual({ endpoint: devices[0].endpoint, keys: { p256dh: 'p1', auth: 'a1' } });
    expect(JSON.parse(payload)).toEqual(message);
    expect(options).toMatchObject({ TTL: 86400, urgency: 'normal', topic: pushTopic(message.tag) });
    expect(prisma.pushDevice.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['d1', 'd2'] } }, data: { lastNotifiedAt: expect.any(Date) } });
  });

  it('keeps a topic to 32 URL-safe characters, the same for the same tag', () => {
    expect(pushTopic('chat:!room:chat.bawes.net')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pushTopic('a')).toBe(pushTopic('a'));
    expect(pushTopic('a')).not.toBe(pushTopic('b'));
  });

  it('sends nothing when that kind is switched off', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, friendRequests: false });
    expect(await sendPush('user-a', 'friendRequests', message)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when the server has no keys', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    expect(await sendPush('user-a', 'friendRequests', message)).toBe(0);
    expect(getPushSettings).not.toHaveBeenCalled();
  });

  it('removes a device the push service says is gone, and keeps one that failed for another reason', async () => {
    // The mocked error takes just a message and a status
    const PushError = WebPushError as unknown as new (message: string, statusCode: number) => Error;
    send.mockRejectedValueOnce(new PushError('gone', 410)).mockRejectedValueOnce(new PushError('busy', 503));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await sendPush('user-a', 'friendRequests', message)).toBe(0);
    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { id: 'd1' } });
    expect(prisma.pushDevice.updateMany).not.toHaveBeenCalled();
  });

  it('never throws, so what caused it still succeeds', async () => {
    (getPushSettings as jest.Mock).mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(sendPush('user-a', 'friendRequests', message)).resolves.toBe(0);
  });

  it('sends the same tag to the same person once a day', async () => {
    const tagged = { ...message, tag: 'friend-request:once-a-day' };
    expect(await sendPushOnceADay('user-a', 'friendRequests', tagged)).toBe(2);
    expect(await sendPushOnceADay('user-a', 'friendRequests', tagged)).toBe(0);
    expect(await sendPushOnceADay('user-b', 'friendRequests', tagged)).toBe(2);
  });

  it('still sends later that day when the first one reached no device', async () => {
    const tagged = { ...message, tag: 'friend-request:no-device-yet' };
    (prisma.pushDevice.findMany as jest.Mock).mockResolvedValueOnce([]);
    expect(await sendPushOnceADay('user-a', 'friendRequests', tagged)).toBe(0);
    expect(await sendPushOnceADay('user-a', 'friendRequests', tagged)).toBe(2);
    expect(await sendPushOnceADay('user-a', 'friendRequests', tagged)).toBe(0);
  });
});

describe('quiet hours', () => {
  const kuwait = (time: string) => new Date(`2026-10-25T${time}:00+03:00`);
  const night = { start: '22:00', end: '07:00', timeZone: 'Asia/Kuwait' };

  it('cover the night across midnight in their own time zone', () => {
    expect(inQuietHours(night, kuwait('23:30'))).toBe(true);
    expect(inQuietHours(night, kuwait('06:59'))).toBe(true);
    expect(inQuietHours(night, kuwait('07:00'))).toBe(false);
    expect(inQuietHours(night, kuwait('21:59'))).toBe(false);
  });

  it('cover a daytime range', () => {
    const day = { start: '09:00', end: '17:00', timeZone: 'Asia/Kuwait' };
    expect(inQuietHours(day, kuwait('12:00'))).toBe(true);
    expect(inQuietHours(day, kuwait('18:00'))).toBe(false);
  });

  it('are off when not set', () => {
    expect(inQuietHours(null, kuwait('03:00'))).toBe(false);
  });

  it('stop a notification during them', async () => {
    (getPushSettings as jest.Mock).mockResolvedValue({ ...DEFAULT_PUSH_SETTINGS, quietHours: { start: '00:00', end: '23:59', timeZone: 'UTC' } });
    process.env.VAPID_PUBLIC_KEY = 'B' + 'x'.repeat(86);
    process.env.VAPID_PRIVATE_KEY = 'private';
    process.env.VAPID_SUBJECT = 'mailto:team@example.com';
    jest.useFakeTimers().setSystemTime(new Date('2026-10-25T12:00:00Z'));
    try {
      expect(await sendPush('user-a', 'friendRequests', message)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
