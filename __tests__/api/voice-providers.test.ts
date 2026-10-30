/**
 * Voice providers (#740): a super admin sets them up, the bot server reads them without their keys and fetches a key
 * encrypted. Nothing here calls a provider.
 */
import { NextRequest } from 'next/server';
import { GET as listAdmin, POST as createAdmin } from '@/app/api/admin/voice-providers/route';
import { DELETE as deleteAdmin, GET as getAdmin, PATCH as patchAdmin } from '@/app/api/admin/voice-providers/[id]/route';
import { GET as listServed } from '@/app/api/voice/providers/route';
import { GET as credentials } from '@/app/api/voice/providers/[id]/credentials/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    voiceProvider: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  },
}));

const session = getSessionUser as jest.Mock;
const db = (prisma as unknown as { $transaction: jest.Mock; voiceProvider: Record<'findMany' | 'findUnique' | 'create' | 'update' | 'updateMany' | 'delete', jest.Mock> }).voiceProvider;
const transaction = (prisma as unknown as { $transaction: jest.Mock }).$transaction;

const root = { id: 'u-root', email: 'root@example.com' };
const call = (route: (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>, method: string, body?: unknown, headers: Record<string, string> = {}, id = 'p1') =>
  route(new NextRequest('http://localhost:3333/api/x', { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const asGame = { Authorization: 'Bearer service-secret' };

const row = (changes: Record<string, unknown> = {}) => ({
  id: 'p1',
  adapter: 'elevenlabs',
  name: 'ElevenLabs',
  recognition: true,
  speech: true,
  enabled: true,
  endpoint: null,
  region: null,
  apiKeyEncrypted: 'iv:tag:data',
  apiKeyLast4: 'wxyz',
  models: [{ id: 'm1', label: 'Model one', kind: 'speech' }],
  defaultRecognition: false,
  defaultSpeech: false,
  createdById: 'u-root',
  createdAt: new Date('2026-10-30T10:00:00Z'),
  updatedAt: new Date('2026-10-30T10:00:00Z'),
  ...changes,
});

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  (isSuperAdmin as jest.Mock).mockImplementation((email?: string | null) => email === 'root@example.com');
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  session.mockResolvedValue(root);
});

describe('super admin routes', () => {
  it('are for super admins only', async () => {
    session.mockResolvedValue({ id: 'u1', email: 'someone@example.com' });
    for (const response of [
      await listAdmin(new NextRequest('http://localhost:3333/api/x')),
      await createAdmin(new NextRequest('http://localhost:3333/api/x', { method: 'POST', body: '{}' })),
      await call(getAdmin, 'GET'),
      await call(patchAdmin, 'PATCH', { name: 'x' }),
      await call(deleteAdmin, 'DELETE'),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('list providers without their keys', async () => {
    db.findMany.mockResolvedValue([row()]);
    const body = await (await listAdmin(new NextRequest('http://localhost:3333/api/x'))).json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({ id: 'p1', hasKey: true, apiKeyLast4: 'wxyz', models: [{ id: 'm1', label: 'Model one', kind: 'speech' }] });
    expect(JSON.stringify(body)).not.toContain('iv:tag:data');
    expect(body.providers[0]).not.toHaveProperty('apiKeyEncrypted');
  });

  it('add a provider that is off, with its key encrypted and never sent back', async () => {
    db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row({ ...data, id: 'p2' }));
    const response = await createAdmin(
      new NextRequest('http://localhost:3333/api/x', {
        method: 'POST',
        body: JSON.stringify({ adapter: 'deepgram', name: 'Deepgram', recognition: true, apiKey: 'dg-secret-key-1234', models: [{ id: 'nova', kind: 'recognition' }] }),
      })
    );
    expect(response.status).toBe(201);
    const data = db.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ adapter: 'deepgram', name: 'Deepgram', recognition: true, speech: false, enabled: false, apiKeyLast4: '1234', createdById: 'u-root' });
    expect(data.apiKeyEncrypted).not.toContain('dg-secret-key');
    expect(decryptApiKey(data.apiKeyEncrypted)).toBe('dg-secret-key-1234');
    expect(JSON.stringify(await response.json())).not.toContain('dg-secret');
  });

  it('turn down a provider that does nothing, a model it can\'t do, a repeated model, an address that isn\'t https and a field it doesn\'t have', async () => {
    const add = async (body: unknown) => createAdmin(new NextRequest('http://localhost:3333/api/x', { method: 'POST', body: JSON.stringify(body) }));
    expect((await add({ adapter: 'x1', name: 'None' })).status).toBe(400);
    expect((await add({ adapter: 'x1', name: 'Ears', recognition: true, models: [{ id: 'voice', kind: 'speech' }] })).status).toBe(400);
    expect((await add({ adapter: 'x1', name: 'Ears', recognition: true, models: [{ id: 'a', kind: 'recognition' }, { id: 'a', kind: 'recognition' }] })).status).toBe(400);
    expect((await add({ adapter: 'x1', name: 'Ears', recognition: true, endpoint: 'http://example.com' })).status).toBe(400);
    expect((await add({ adapter: 'Bad Name', name: 'Ears', recognition: true })).status).toBe(400);
    expect((await add({ adapter: 'x1', name: 'Ears', recognition: true, defaultSpeech: true })).status).toBe(400);
    expect((await createAdmin(new NextRequest('http://localhost:3333/api/x', { method: 'POST', body: 'nope' }))).status).toBe(400);
    expect(db.create).not.toHaveBeenCalled();
  });

  it('change only what is named, set a new key and take a key away', async () => {
    db.findUnique.mockResolvedValue(row());
    db.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
    expect((await call(patchAdmin, 'PATCH', { name: 'Eleven' })).status).toBe(200);
    expect(db.update.mock.calls[0][0].data).toEqual({ name: 'Eleven', recognition: true, speech: true, enabled: true, defaultRecognition: false, defaultSpeech: false });
    await call(patchAdmin, 'PATCH', { apiKey: 'new-secret-key-0000' });
    const withKey = db.update.mock.calls[1][0].data;
    expect(withKey.apiKeyLast4).toBe('0000');
    expect(decryptApiKey(withKey.apiKeyEncrypted)).toBe('new-secret-key-0000');
    await call(patchAdmin, 'PATCH', { apiKey: null });
    expect(db.update.mock.calls[2][0].data).toMatchObject({ apiKeyEncrypted: null, apiKeyLast4: null });
  });

  it('say so when the provider is not there', async () => {
    db.findUnique.mockResolvedValue(null);
    expect((await call(getAdmin, 'GET')).status).toBe(404);
    expect((await call(patchAdmin, 'PATCH', { name: 'x' })).status).toBe(404);
    expect((await call(deleteAdmin, 'DELETE')).status).toBe(404);
  });

  it('make a provider the default and take it from the one that had it', async () => {
    db.findUnique.mockResolvedValue(row());
    db.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
    expect((await call(patchAdmin, 'PATCH', { defaultSpeech: true })).status).toBe(200);
    expect(db.updateMany).toHaveBeenCalledWith({ where: { defaultSpeech: true }, data: { defaultSpeech: false } });
    expect(db.update.mock.calls[0][0].data.defaultSpeech).toBe(true);
    expect(db.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keep a default on, with its key and doing its job', async () => {
    db.findUnique.mockResolvedValue(row({ defaultSpeech: true }));
    for (const change of [{ enabled: false }, { apiKey: null }, { speech: false }]) {
      const response = await call(patchAdmin, 'PATCH', change);
      expect(response.status).toBe(409);
    }
    db.findUnique.mockResolvedValue(row({ enabled: false }));
    expect((await call(patchAdmin, 'PATCH', { defaultRecognition: true })).status).toBe(400);
    db.findUnique.mockResolvedValue(row({ apiKeyEncrypted: null, apiKeyLast4: null }));
    expect((await call(patchAdmin, 'PATCH', { defaultRecognition: true })).status).toBe(400);
    db.findUnique.mockResolvedValue(row({ speech: false }));
    expect((await call(patchAdmin, 'PATCH', { defaultSpeech: true })).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('ask again when two super admins make a default at the same moment', async () => {
    db.findUnique.mockResolvedValue(row());
    db.update.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const response = await call(patchAdmin, 'PATCH', { defaultSpeech: true });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Another provider was just made the default. Check the list and try again');
  });

  it('remove a provider unless it is a default', async () => {
    db.findUnique.mockResolvedValue(row({ defaultRecognition: true }));
    const refused = await call(deleteAdmin, 'DELETE');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('Make another provider the default for what this one does first');
    expect(db.delete).not.toHaveBeenCalled();
    db.findUnique.mockResolvedValue(row());
    expect((await call(deleteAdmin, 'DELETE')).status).toBe(200);
    expect(db.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});

describe('what the bot server reads', () => {
  it('needs the service token, not a session', async () => {
    expect((await listServed(new NextRequest('http://localhost:3333/api/x'))).status).toBe(401);
    expect((await call(credentials, 'GET')).status).toBe(401);
    expect((await call(credentials, 'GET', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('lists the providers that are on, without keys, and the defaults', async () => {
    db.findMany.mockResolvedValue([row({ defaultSpeech: true }), row({ id: 'p2', name: 'Deepgram', speech: false, defaultRecognition: true })]);
    const response = await listServed(new NextRequest('http://localhost:3333/api/x', { headers: asGame }));
    expect(response.status).toBe(200);
    expect(db.findMany.mock.calls[0][0].where).toEqual({ enabled: true });
    const body = await response.json();
    expect(body.defaults).toEqual({ recognition: 'p2', speech: 'p1' });
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
    expect(JSON.stringify(body)).not.toContain('iv:tag:data');
    expect(body.providers[0]).toMatchObject({ hasKey: true, models: [{ id: 'm1', kind: 'speech', label: 'Model one' }] });
  });

  it('has no default when none is set', async () => {
    db.findMany.mockResolvedValue([row()]);
    expect((await (await listServed(new NextRequest('http://localhost:3333/api/x', { headers: asGame }))).json()).defaults).toEqual({ recognition: null, speech: null });
  });

  it('serves a key still encrypted, and only for a provider that is on and has one', async () => {
    db.findUnique.mockResolvedValue(row());
    const ok = await call(credentials, 'GET', undefined, asGame);
    expect(ok.status).toBe(200);
    expect((await ok.json()).apiKeyEncrypted).toBe('iv:tag:data');
    db.findUnique.mockResolvedValue(row({ enabled: false }));
    expect((await call(credentials, 'GET', undefined, asGame)).status).toBe(400);
    db.findUnique.mockResolvedValue(row({ apiKeyEncrypted: null }));
    expect((await call(credentials, 'GET', undefined, asGame)).status).toBe(400);
    db.findUnique.mockResolvedValue(null);
    expect((await call(credentials, 'GET', undefined, asGame)).status).toBe(404);
  });
});
