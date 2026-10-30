/**
 * Personal voice keys (#749): a person adds a voice key, lends it to a universe where they manage bots, and nobody else sees
 * or changes it. The server's own voice providers never show a person's key. Nothing here calls a provider.
 */
import { NextRequest } from 'next/server';
import { GET as list, POST as create } from '@/app/api/me/voice-keys/route';
import { DELETE as remove, PATCH as patch } from '@/app/api/me/voice-keys/[id]/route';
import { POST as lend } from '@/app/api/me/voice-keys/[id]/lend/route';
import { DELETE as pull } from '@/app/api/me/voice-keys/[id]/lend/[universeId]/route';
import { GET as listAdmin } from '@/app/api/admin/voice-providers/route';
import { GET as getAdmin } from '@/app/api/admin/voice-providers/[id]/route';
import { GET as listServed } from '@/app/api/voice/providers/route';
import { GET as credentials } from '@/app/api/voice/providers/[id]/credentials/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { lendAccess } from '@/lib/ai-key-lend';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ ...jest.requireActual('@/lib/ai-key-lend'), lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    voiceProvider: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    voiceKeyLend: { findMany: jest.fn(), update: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  },
}));

type Mocks = Record<string, jest.Mock>;
const db = prisma as unknown as { $transaction: jest.Mock; voiceProvider: Mocks; voiceKeyLend: Mocks };
const session = getSessionUser as jest.Mock;

const ana = { id: 'u-ana', email: 'ana@example.com', name: 'Ana' };
type Context = { params: Promise<{ id: string; universeId: string }> };
const call = (route: (request: NextRequest, context: Context) => Promise<Response>, method: string, body?: unknown, id = 'k1', universeId = 'uni1') =>
  route(new NextRequest('http://localhost:3333/api/x', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), {
    params: Promise.resolve({ id, universeId }),
  });

const key = (changes: Record<string, unknown> = {}) => ({
  id: 'k1',
  adapter: 'elevenlabs',
  name: 'My ElevenLabs',
  recognition: false,
  speech: true,
  enabled: true,
  endpoint: null,
  region: null,
  apiKeyEncrypted: 'iv:tag:data',
  apiKeyLast4: '9f2a',
  models: [
    { id: 'flash', label: 'Flash', kind: 'speech' },
    { id: 'turbo', label: 'Turbo', kind: 'speech' },
  ],
  defaultRecognition: false,
  defaultSpeech: false,
  ownerId: 'u-ana',
  createdById: 'u-ana',
  createdAt: new Date('2026-10-31T10:00:00Z'),
  updatedAt: new Date('2026-10-31T10:00:00Z'),
  lends: [] as unknown[],
  ...changes,
});
const lent = (models: string[] | null = null) => ({ models, universe: { id: 'uni1', name: 'Sales', ownerId: 'u-ana' } });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  (isSuperAdmin as jest.Mock).mockImplementation((email?: string | null) => email === 'root@example.com');
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  session.mockResolvedValue(ana);
});

describe('voice keys are for signed-in people', () => {
  it('turn away everyone else', async () => {
    session.mockResolvedValue(null);
    for (const response of [
      await list(new NextRequest('http://localhost:3333/api/x')),
      await call(create, 'POST', {}),
      await call(patch, 'PATCH', {}),
      await call(remove, 'DELETE'),
      await call(lend, 'POST', {}),
      await call(pull, 'DELETE'),
    ]) {
      expect(response.status).toBe(401);
    }
    expect(db.voiceProvider.create).not.toHaveBeenCalled();
  });
});

describe('adding a key', () => {
  it('saves it encrypted for its owner, on, and never a default', async () => {
    db.voiceProvider.create.mockImplementation(async ({ data }) => key({ ...data, id: 'k1', createdAt: new Date('2026-10-31T10:00:00Z'), lends: [] }));
    const response = await call(create, 'POST', {
      adapter: 'elevenlabs',
      speech: true,
      apiKey: 'sk-secret-key-9f2a',
      models: [{ id: 'flash', label: 'Flash', kind: 'speech' }],
    });
    expect(response.status).toBe(201);
    const { data } = db.voiceProvider.create.mock.calls[0][0];
    expect(data).toMatchObject({ adapter: 'elevenlabs', name: 'ElevenLabs', speech: true, recognition: false, enabled: true, ownerId: 'u-ana', createdById: 'u-ana', apiKeyLast4: '9f2a' });
    expect(data).not.toHaveProperty('defaultSpeech');
    expect(decryptApiKey(data.apiKeyEncrypted)).toBe('sk-secret-key-9f2a');
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('sk-secret-key-9f2a');
    expect(text).not.toContain('apiKeyEncrypted');
    expect(text).toContain('9f2a');
  });

  it.each([
    ['a company that isn’t on the list', { adapter: 'unknown-co', speech: true, apiKey: 'sk-secret-key-9f2a' }],
    ['a key that does nothing', { adapter: 'elevenlabs', apiKey: 'sk-secret-key-9f2a' }],
    ['a key that is too short', { adapter: 'elevenlabs', speech: true, apiKey: 'short' }],
    ['a model for a job the key doesn’t do', { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', models: [{ id: 'a', kind: 'recognition' }] }],
    ['a field it doesn’t know (an endpoint, a default)', { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', endpoint: 'https://x.example.com' }],
    ['a default', { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', defaultSpeech: true }],
  ])('refuses %s', async (_name, body) => {
    expect((await call(create, 'POST', body)).status).toBe(400);
    expect(db.voiceProvider.create).not.toHaveBeenCalled();
  });
});

describe('the list', () => {
  it('is the caller’s own keys with where each is lent, and the companies', async () => {
    db.voiceProvider.findMany.mockResolvedValue([key({ lends: [lent(['speech:flash'])] })]);
    const response = await list(new NextRequest('http://localhost:3333/api/x'));
    expect(db.voiceProvider.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'u-ana' });
    const body = await response.json();
    expect(body.keys).toEqual([
      expect.objectContaining({ id: 'k1', company: 'ElevenLabs', last4: '9f2a', lentTo: [{ universeId: 'uni1', universeName: 'Sales', ownedByYou: true, models: ['speech:flash'] }] }),
    ]);
    expect(body.companies.map((c: { adapter: string }) => c.adapter)).toEqual(['elevenlabs', 'deepgram', 'cartesia']);
    expect(JSON.stringify(body)).not.toContain('apiKeyEncrypted');
  });
});

describe('changing a key', () => {
  it('is only ever the owner’s: someone else’s key is not found', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(null);
    expect((await call(patch, 'PATCH', { name: 'x' })).status).toBe(404);
    expect((await call(lend, 'POST', { universeId: 'uni1' })).status).toBe(404);
    expect(db.voiceProvider.findFirst.mock.calls.every(([arg]) => arg.where.ownerId === 'u-ana')).toBe(true);
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
  });

  it('takes a new key, encrypted, and a new name', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    const response = await call(patch, 'PATCH', { name: 'Studio', apiKey: 'sk-new-key-abcd' });
    expect(response.status).toBe(200);
    const { data } = db.voiceProvider.update.mock.calls[0][0];
    expect(data).toMatchObject({ name: 'Studio', apiKeyLast4: 'abcd' });
    expect(decryptApiKey(data.apiKeyEncrypted)).toBe('sk-new-key-abcd');
    expect(db.voiceKeyLend.findMany).not.toHaveBeenCalled();
  });

  it('takes a model off every lend that named it, and a lend left with none goes back to all', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    db.voiceKeyLend.findMany.mockResolvedValue([
      { id: 'l1', models: ['speech:flash', 'speech:turbo'] },
      { id: 'l2', models: ['speech:turbo'] },
      { id: 'l3', models: ['speech:flash'] },
    ]);
    const response = await call(patch, 'PATCH', { models: [{ id: 'flash', kind: 'speech' }] });
    expect(response.status).toBe(200);
    const updates = db.voiceKeyLend.update.mock.calls.map(([arg]) => [arg.where.id, arg.data.models]);
    expect(updates).toEqual([
      ['l1', ['speech:flash']],
      ['l2', expect.anything()],
    ]);
  });

  it('refuses a model for a job the key doesn’t do', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    expect((await call(patch, 'PATCH', { models: [{ id: 'a', kind: 'recognition' }] })).status).toBe(400);
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
  });

  it('removes only the caller’s own key', async () => {
    db.voiceProvider.deleteMany.mockResolvedValue({ count: 1 });
    expect((await call(remove, 'DELETE')).status).toBe(200);
    expect(db.voiceProvider.deleteMany).toHaveBeenCalledWith({ where: { id: 'k1', ownerId: 'u-ana' } });
    db.voiceProvider.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call(remove, 'DELETE')).status).toBe(404);
  });
});

describe('lending', () => {
  it('needs Manage bots in the universe', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    (lendAccess as jest.Mock).mockResolvedValue(null);
    const response = await call(lend, 'POST', { universeId: 'uni1' });
    expect(response.status).toBe(403);
    expect(db.voiceKeyLend.upsert).not.toHaveBeenCalled();
  });

  it('lends the key with all of its models, then answers with where it is lent', async () => {
    db.voiceProvider.findFirst.mockResolvedValueOnce(key()).mockResolvedValueOnce(key({ lends: [lent(null)] }));
    (lendAccess as jest.Mock).mockResolvedValue('owner');
    const response = await call(lend, 'POST', { universeId: 'uni1' });
    expect(response.status).toBe(200);
    expect(db.voiceKeyLend.upsert).toHaveBeenCalledWith({
      where: { providerId_universeId: { providerId: 'k1', universeId: 'uni1' } },
      create: { providerId: 'k1', universeId: 'uni1' },
      update: {},
    });
    expect((await response.json()).key.lentTo).toEqual([{ universeId: 'uni1', universeName: 'Sales', ownedByYou: true, models: null }]);
  });

  it('keeps only the models named, in the key’s order, each of them on the key’s list', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    (lendAccess as jest.Mock).mockResolvedValue('manage');
    expect((await call(lend, 'POST', { universeId: 'uni1', models: ['speech:turbo', 'speech:flash'] })).status).toBe(200);
    expect(db.voiceKeyLend.upsert.mock.calls[0][0].create.models).toEqual(['speech:flash', 'speech:turbo']);
    db.voiceKeyLend.upsert.mockClear();
    const refused = await call(lend, 'POST', { universeId: 'uni1', models: ['speech:gone'] });
    expect(refused.status).toBe(400);
    expect(db.voiceKeyLend.upsert).not.toHaveBeenCalled();
  });

  it('asks for a universe, and a model list that is neither empty nor all', async () => {
    expect((await call(lend, 'POST', {})).status).toBe(400);
    db.voiceProvider.findFirst.mockResolvedValue(key());
    (lendAccess as jest.Mock).mockResolvedValue('owner');
    expect((await call(lend, 'POST', { universeId: 'uni1', models: [] })).status).toBe(400);
  });

  it('is pulled by the key’s owner alone', async () => {
    db.voiceKeyLend.deleteMany.mockResolvedValue({ count: 1 });
    expect((await call(pull, 'DELETE')).status).toBe(200);
    expect(db.voiceKeyLend.deleteMany).toHaveBeenCalledWith({ where: { providerId: 'k1', universeId: 'uni1', provider: { ownerId: 'u-ana' } } });
    db.voiceKeyLend.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call(pull, 'DELETE')).status).toBe(404);
  });
});

describe('the server’s own voice providers', () => {
  it('never list, serve or hand out a person’s key', async () => {
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com' });
    db.voiceProvider.findMany.mockResolvedValue([]);
    await listAdmin(new NextRequest('http://localhost:3333/api/x'));
    expect(db.voiceProvider.findMany.mock.calls[0][0].where).toEqual({ ownerId: null });
    db.voiceProvider.findMany.mockClear();
    await listServed(new NextRequest('http://localhost:3333/api/x', { headers: { Authorization: 'Bearer service-secret' } }));
    expect(db.voiceProvider.findMany.mock.calls[0][0].where).toEqual({ enabled: true, ownerId: null });

    db.voiceProvider.findUnique.mockResolvedValue(key());
    const context = { params: Promise.resolve({ id: 'k1' }) };
    expect((await getAdmin(new NextRequest('http://localhost:3333/api/x'), context)).status).toBe(404);
    const served = await credentials(new NextRequest('http://localhost:3333/api/x', { headers: { Authorization: 'Bearer service-secret' } }), context);
    expect(served.status).toBe(404);
  });
});
