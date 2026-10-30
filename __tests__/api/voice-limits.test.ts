/**
 * Voice limits (#740): a super admin sets them, the game reads them with a service token, and a change reaches the game
 * with no deploy. The universe switch is saved by the universe's owner and by a super admin.
 */
import { NextRequest } from 'next/server';
import { GET as getAdmin, PATCH as patchAdmin } from '@/app/api/admin/voice-limits/route';
import { GET as getServed } from '@/app/api/voice/limits/route';
import { PATCH as patchUniverse } from '@/app/api/admin/universes/[id]/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { isSuperAdmin } from '@/lib/super-admin';
import { VOICE_LIMITS_RECOMMENDED } from '@/lib/voice-limit-values';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn((email?: string | null) => email === 'root@example.com') }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    appSetting: { findUnique: jest.fn(), upsert: jest.fn() },
    universe: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

const session = getSessionUser as jest.Mock;
const db = prisma as unknown as {
  $transaction: jest.Mock;
  appSetting: { findUnique: jest.Mock; upsert: jest.Mock };
  universe: { findUnique: jest.Mock; update: jest.Mock };
};

const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost:3333/api/x', { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const root = { id: 'u-root', email: 'root@example.com' };

beforeEach(() => {
  jest.resetAllMocks();
  (isSuperAdmin as jest.Mock).mockImplementation((email?: string | null) => email === 'root@example.com');
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  db.appSetting.findUnique.mockResolvedValue(null);
  db.appSetting.upsert.mockResolvedValue({});
});

describe('GET /api/admin/voice-limits', () => {
  it('is for super admins only', async () => {
    session.mockResolvedValue(null);
    expect((await getAdmin(request('GET'))).status).toBe(403);
    session.mockResolvedValue({ id: 'u1', email: 'someone@example.com' });
    expect((await getAdmin(request('GET'))).status).toBe(403);
  });

  it('gives the recommended values until something is saved', async () => {
    session.mockResolvedValue(root);
    const response = await getAdmin(request('GET'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ limits: VOICE_LIMITS_RECOMMENDED, revision: 0 });
  });
});

describe('PATCH /api/admin/voice-limits', () => {
  it('is for super admins only, and saves nothing for anyone else', async () => {
    session.mockResolvedValue({ id: 'u1', email: 'someone@example.com' });
    expect((await patchAdmin(request('PATCH', { turnSeconds: 90 }))).status).toBe(403);
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('changes only the values it names and goes up one revision each save', async () => {
    session.mockResolvedValue(root);
    db.appSetting.findUnique.mockResolvedValue({ key: 'voice-limits', value: { limits: { replyCharacters: 400 }, revision: 3 } });
    const response = await patchAdmin(request('PATCH', { turnSeconds: 90 }));
    expect(response.status).toBe(200);
    const expected = { limits: { ...VOICE_LIMITS_RECOMMENDED, replyCharacters: 400, turnSeconds: 90 }, revision: 4 };
    expect(await response.json()).toEqual(expected);
    expect(db.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'voice-limits' },
      create: { key: 'voice-limits', value: expected, updatedById: 'u-root' },
      update: { value: expected, updatedById: 'u-root' },
    });
  });

  it('turns down a value that does not fit, a name that is not a limit and a body that is not JSON', async () => {
    session.mockResolvedValue(root);
    const tooShort = await patchAdmin(request('PATCH', { replyCharacters: 3 }));
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toBe('replyCharacters must be a whole number from 50 to 20,000');
    expect((await patchAdmin(request('PATCH', { voice: 'nora' }))).status).toBe(400);
    const broken = new NextRequest('http://localhost:3333/api/x', { method: 'PATCH', body: '{nope' });
    expect((await patchAdmin(broken)).status).toBe(400);
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('says so when it could not save', async () => {
    session.mockResolvedValue(root);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    db.$transaction.mockRejectedValue(new Error('down'));
    expect((await patchAdmin(request('PATCH', { turnSeconds: 90 }))).status).toBe(500);
  });
});

describe('GET /api/voice/limits', () => {
  const asGame = { Authorization: 'Bearer service-secret' };

  it('needs the service token, not a session', async () => {
    session.mockResolvedValue(root);
    expect((await getServed(request('GET'))).status).toBe(401);
    expect((await getServed(request('GET', undefined, { Authorization: 'Bearer wrong' }))).status).toBe(401);
  });

  it('gives the limits and the voice replies they leave in today\'s windows', async () => {
    const response = await getServed(request('GET', undefined, asGame));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      revision: 0,
      limits: VOICE_LIMITS_RECOMMENDED,
      window: {
        hours: 5,
        signedIn: { replies: 30, textReserve: 5, voiceReplies: 25 },
        guest: { replies: 10, textReserve: 2, voiceReplies: 3 },
      },
    });
  });

  it('reads a change with no deploy, including a change to the fair usage windows', async () => {
    db.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'voice-limits'
        ? { value: { limits: { textReserveShare: 3, guestVoiceReplies: 5 }, revision: 7 } }
        : { value: { fairUsage: { signedIn: 12, guest: 12 } } }
    );
    const body = await (await getServed(request('GET', undefined, asGame))).json();
    expect(body.revision).toBe(7);
    expect(body.limits).toMatchObject({ textReserveShare: 3, guestVoiceReplies: 5 });
    expect(body.window.signedIn).toEqual({ replies: 12, textReserve: 4, voiceReplies: 8 });
    expect(body.window.guest).toEqual({ replies: 12, textReserve: 4, voiceReplies: 5 });
  });

  it('gives the recommended values when the saved ones can\'t be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    db.appSetting.findUnique.mockRejectedValue(new Error('down'));
    const body = await (await getServed(request('GET', undefined, asGame))).json();
    expect(body.limits).toEqual(VOICE_LIMITS_RECOMMENDED);
  });
});

describe('Allow voice bots here', () => {
  const patch = (body: unknown) =>
    patchUniverse(new NextRequest('http://localhost:3333/api/admin/universes/u1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: 'u1' }),
    });

  beforeEach(() => {
    db.universe.findUnique.mockResolvedValue({ id: 'u1', slug: 'acme', ownerId: 'u-owner', featured: false });
    db.universe.update.mockResolvedValue({ id: 'u1' });
  });

  it('is saved by the owner and by a super admin, and left alone when not sent', async () => {
    session.mockResolvedValue({ id: 'u-owner', email: 'owner@example.com', isSuperAdmin: false });
    expect((await patch({ allowVoiceBots: false })).status).toBe(200);
    expect(db.universe.update.mock.calls[0][0].data).toEqual({ allowVoiceBots: false });
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com', isSuperAdmin: true });
    await patch({ name: 'Acme 2' });
    expect(db.universe.update.mock.calls[1][0].data).toEqual({ name: 'Acme 2' });
  });

  it('is not saved for anyone who is not the owner or a super admin', async () => {
    session.mockResolvedValue({ id: 'u-other', email: 'other@example.com', isSuperAdmin: false });
    expect((await patch({ allowVoiceBots: false })).status).toBeGreaterThanOrEqual(403);
    expect(db.universe.update).not.toHaveBeenCalled();
  });
});
