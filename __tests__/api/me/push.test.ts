import { NextRequest } from 'next/server';
import { GET } from '@/app/api/me/push/route';
import { DELETE as removeByEndpoint, POST as register } from '@/app/api/me/push/devices/route';
import { DELETE as removeDevice, PATCH as switchDevice } from '@/app/api/me/push/devices/[id]/route';
import { PATCH as changeSettings } from '@/app/api/me/push/settings/route';
import { getSessionUser } from '@/lib/auth-session';
import { listPushDevices, registerPushDevice, removePushDevice, removePushDeviceByEndpoint, setPushDeviceEnabled } from '@/lib/push-devices';
import { DEFAULT_PUSH_SETTINGS, getPushSettings, updatePushSettings } from '@/lib/push-settings';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/push-devices', () => ({
  ...jest.requireActual('@/lib/push-devices'),
  listPushDevices: jest.fn(),
  registerPushDevice: jest.fn(),
  setPushDeviceEnabled: jest.fn(),
  removePushDevice: jest.fn(),
  removePushDeviceByEndpoint: jest.fn(),
}));
jest.mock('@/lib/push-settings', () => ({
  ...jest.requireActual('@/lib/push-settings'),
  getPushSettings: jest.fn(),
  updatePushSettings: jest.fn(),
}));

const BASE = 'http://localhost:3333/api/me/push';
const PUBLIC_KEY = 'B' + 'x'.repeat(86);
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };
const device = { id: 'd1', label: 'Chrome on Android', enabled: true, lastNotifiedAt: null, createdAt: '2026-10-25T18:00:00.000Z' };
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'a'.repeat(22) },
  label: 'Chrome on Android',
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('/api/me/push', () => {
  const savedKey = process.env.VAPID_PUBLIC_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAPID_PUBLIC_KEY = PUBLIC_KEY;
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
    (getPushSettings as jest.Mock).mockResolvedValue(DEFAULT_PUSH_SETTINGS);
    (listPushDevices as jest.Mock).mockResolvedValue([device]);
  });

  afterAll(() => {
    process.env.VAPID_PUBLIC_KEY = savedKey;
  });

  it('answers with the subscribe key, the settings and the devices, never cached', async () => {
    const response = await GET(request('', 'GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ publicKey: PUBLIC_KEY, settings: DEFAULT_PUSH_SETTINGS, devices: [device] });
    expect(listPushDevices).toHaveBeenCalledWith('user-a');
  });

  it('says notifications are not set up when the server has no key, and refuses to register', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect((await (await GET(request('', 'GET'))).json()).publicKey).toBeNull();
    expect((await register(request('/devices', 'POST', subscription))).status).toBe(503);
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it('is only for someone signed in, from Orbit or the game', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await GET(request('', 'GET'))).status).toBe(401);
    expect((await register(request('/devices', 'POST', subscription))).status).toBe(401);
    expect((await changeSettings(request('/settings', 'PATCH', { friendLive: true }))).status).toBe(401);

    (getSessionUser as jest.Mock).mockResolvedValue(alice);
    const evil = await GET(request('', 'GET', undefined, { origin: 'https://evil.example.com' }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('registers this browser for the caller', async () => {
    (registerPushDevice as jest.Mock).mockResolvedValue(device);
    const response = await register(request('/devices', 'POST', subscription));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ device });
    expect(registerPushDevice).toHaveBeenCalledWith('user-a', {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      label: 'Chrome on Android',
    });
  });

  it('refuses a subscription that does not point at a browser push service', async () => {
    const response = await register(request('/devices', 'POST', { ...subscription, endpoint: 'https://evil.example.com/x' }));
    expect(response.status).toBe(400);
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it('removes this browser on sign-out, and counts one already gone as done', async () => {
    (removePushDeviceByEndpoint as jest.Mock).mockResolvedValue(false);
    const response = await removeByEndpoint(request('/devices', 'DELETE', { endpoint: subscription.endpoint }));
    expect(response.status).toBe(200);
    expect(removePushDeviceByEndpoint).toHaveBeenCalledWith('user-a', subscription.endpoint);
  });

  it('switches one of the caller’s devices, and 404s on anyone else’s', async () => {
    (setPushDeviceEnabled as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await (await switchDevice(request('/devices/d1', 'PATCH', { enabled: false }), params('d1'))).json()).toEqual({ id: 'd1', enabled: false });
    expect(setPushDeviceEnabled).toHaveBeenCalledWith('user-a', 'd1', false);
    expect((await switchDevice(request('/devices/d2', 'PATCH', { enabled: false }), params('d2'))).status).toBe(404);
    expect((await switchDevice(request('/devices/d1', 'PATCH', { enabled: 'no' }), params('d1'))).status).toBe(400);
  });

  it('removes one of the caller’s devices, and 404s on anyone else’s', async () => {
    (removePushDevice as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await removeDevice(request('/devices/d1', 'DELETE'), params('d1'))).status).toBe(200);
    expect(removePushDevice).toHaveBeenCalledWith('user-a', 'd1');
    expect((await removeDevice(request('/devices/d2', 'DELETE'), params('d2'))).status).toBe(404);
  });

  it('saves a settings change and answers with all settings; an invalid one is a 400', async () => {
    const saved = { ...DEFAULT_PUSH_SETTINGS, friendLive: true };
    (updatePushSettings as jest.Mock).mockResolvedValueOnce(saved).mockResolvedValueOnce(null);
    expect(await (await changeSettings(request('/settings', 'PATCH', { friendLive: true }))).json()).toEqual({ settings: saved });
    expect(updatePushSettings).toHaveBeenCalledWith('user-a', { friendLive: true });
    expect((await changeSettings(request('/settings', 'PATCH', { sound: true }))).status).toBe(400);
  });
});
