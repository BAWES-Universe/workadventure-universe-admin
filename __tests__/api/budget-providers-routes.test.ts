/**
 * The two routes behind a company's row: Soniox's organization key (saved only after Soniox accepts it, never sent back) and the payment link at
 * Agent37. Both are a super admin's.
 */
import { NextRequest } from 'next/server';
import { PUT as putKey, DELETE as deleteKey } from '@/app/api/admin/budget/soniox-key/route';
import { POST as postFunds } from '@/app/api/admin/budget/funds/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { buildReport } from '@/lib/budget/report';
import { clearSonioxOrgKey, saveSonioxOrgKey } from '@/lib/budget/provider-keys';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/budget/report', () => ({ buildReport: jest.fn() }));
jest.mock('@/lib/budget/provider-keys', () => ({ ...jest.requireActual('@/lib/budget/provider-keys'), saveSonioxOrgKey: jest.fn(), clearSonioxOrgKey: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/app-adapter', () => ({ getAdapter: jest.fn() }));
jest.mock('@/lib/composio-billing', () => ({ readComposioBilling: jest.fn() }));

const session = getSessionUser as jest.Mock;
const admin = isSuperAdmin as jest.Mock;
const report = buildReport as jest.Mock;
const save = saveSonioxOrgKey as jest.Mock;
const clear = clearSonioxOrgKey as jest.Mock;

const request = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost:3333${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const sendKey = (key: unknown) => putKey(request('/api/admin/budget/soniox-key', 'PUT', { key }));
const sendFunds = (body: unknown) => postFunds(request('/api/admin/budget/funds', 'POST', body));

const realFetch = global.fetch;
const fetchMock = jest.fn();
const sonioxAnswer = { available_balance_usd: '12', balance_exhausted: false, invoice_billing_enabled: false, autopay_enabled: false, has_payment_method: true, has_payment_error: false };
const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  session.mockReset().mockResolvedValue({ id: 'khalid', email: 'khalid@example.test' });
  admin.mockReset().mockReturnValue(true);
  report.mockReset().mockResolvedValue({ accounts: [{ key: 'soniox', name: 'Soniox', state: 'ok' }] });
  save.mockReset().mockResolvedValue(undefined);
  clear.mockReset().mockResolvedValue(undefined);
  delete process.env.AGENT37_API_KEY;
});
afterAll(() => {
  global.fetch = realFetch;
});

describe('who may use them', () => {
  it('turns a member away with 403 and touches nothing', async () => {
    admin.mockReturnValue(false);
    expect((await sendKey('snx_org_abc')).status).toBe(403);
    expect((await deleteKey(request('/api/admin/budget/soniox-key', 'DELETE'))).status).toBe(403);
    expect((await sendFunds({ company: 'agent37', amountUsd: 25 })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('Soniox’s organization key', () => {
  it('keeps a key only after Soniox accepted it, and never sends it back', async () => {
    fetchMock.mockImplementation(() => reply(200, sonioxAnswer));
    const response = await sendKey('  snx_org_secret123  ');
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.soniox.com/v1/organization/balance');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer snx_org_secret123');
    expect(save).toHaveBeenCalledWith('snx_org_secret123', 'khalid');
    expect(JSON.stringify(await response.json())).not.toContain('secret123');
  });

  it('does not keep a key Soniox refuses, and says so', async () => {
    fetchMock.mockImplementation(() => reply(401, {}));
    const response = await sendKey('snx_org_wrong');
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('The key was not saved');
    expect(save).not.toHaveBeenCalled();
  });

  it('does not keep a key when Soniox cannot be reached', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('network')));
    expect((await sendKey('snx_org_abc')).status).toBe(502);
    expect(save).not.toHaveBeenCalled();
  });

  it('turns away a project key and an empty one before asking Soniox anything', async () => {
    const project = await sendKey('a-project-key');
    expect(project.status).toBe(400);
    expect((await project.json()).error).toContain('snx_org_');
    expect((await sendKey('  ')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disconnects: removes the key and answers with the row as it reads now', async () => {
    const response = await deleteKey(request('/api/admin/budget/soniox-key', 'DELETE'));
    expect(response.status).toBe(200);
    expect(clear).toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ onlyCompany: 'soniox' }));
  });
});

describe('a payment link at Agent37', () => {
  it('asks Agent37 for a link for the typed amount and hands it back', async () => {
    process.env.AGENT37_API_KEY = 'sk_live_test';
    fetchMock.mockImplementation(() => reply(201, { url: 'https://checkout.example.test/pay/1', amount_usd: 25, paid: false }));
    const response = await sendFunds({ company: 'agent37', amountUsd: '$25' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.example.test/pay/1', amountUsd: 25 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ amount_usd: 25 });
  });

  it('passes on Agent37’s refusal of an amount, and offers links for no other company', async () => {
    process.env.AGENT37_API_KEY = 'sk_live_test';
    fetchMock.mockImplementation(() => reply(400, { error: { message: 'below the lowest top up' } }));
    const refused = await sendFunds({ company: 'agent37', amountUsd: 1 });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toContain('below the lowest top up');
    expect((await sendFunds({ company: 'elevenlabs', amountUsd: 25 })).status).toBe(400);
  });

  it('says so when Agent37 is not set up here', async () => {
    expect((await sendFunds({ company: 'agent37', amountUsd: 25 })).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
