/**
 * /api/bots/:id/actions and /api/bots/:id/action-grants (#739): only the bot server's service token gets in, a body that
 * is not valid is a 400 and saves nothing, and a tap or claim that lost is a 409 that says what happened.
 */
import { NextRequest } from 'next/server';
import { POST as CREATE } from '@/app/api/bots/[id]/actions/route';
import { GET as READ } from '@/app/api/bots/[id]/actions/[actionId]/route';
import { POST as DECIDE } from '@/app/api/bots/[id]/actions/[actionId]/decision/route';
import { POST as CLAIM } from '@/app/api/bots/[id]/actions/[actionId]/claim/route';
import { POST as FINISH } from '@/app/api/bots/[id]/actions/[actionId]/finish/route';
import { POST as RECONCILE } from '@/app/api/bots/[id]/actions/[actionId]/reconcile/route';
import { POST as SUPERSEDE } from '@/app/api/bots/[id]/actions/supersede/route';
import { POST as SWEEP } from '@/app/api/bots/[id]/actions/sweep/route';
import { POST as FIND } from '@/app/api/bots/[id]/action-grants/find/route';
import { POST as TOUCH } from '@/app/api/bots/[id]/action-grants/touch/route';
import { POST as REVOKE } from '@/app/api/bots/[id]/action-grants/revoke/route';
import * as lib from '@/lib/bot-actions';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/bot-actions', () => ({
  ...jest.requireActual('@/lib/bot-actions'),
  createRequest: jest.fn(),
  readRequest: jest.fn(),
  decide: jest.fn(),
  claim: jest.fn(),
  finishAttempt: jest.fn(),
  reconcile: jest.fn(),
  supersedeWaiting: jest.fn(),
  sweep: jest.fn(),
  findGrant: jest.fn(),
  touchGrants: jest.fn(),
  revokeGrants: jest.fn(),
}));

const MOCKED = ['createRequest', 'readRequest', 'decide', 'claim', 'finishAttempt', 'reconcile', 'supersedeWaiting', 'sweep', 'findGrant', 'touchGrants', 'revokeGrants'] as const;
const mocks = lib as unknown as Record<(typeof MOCKED)[number], jest.Mock>;

const params = { params: Promise.resolve({ id: 'bot-1', actionId: 'act-1' }) };
type Handler = (r: NextRequest, c: typeof params) => Promise<Response>;

const call = (handler: Handler, method: string, body?: unknown, token: string | null = 'service-secret') =>
  handler(
    new NextRequest('http://localhost:3333/api/bots/bot-1/actions', {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    params,
  );

const ACTION = { id: 'act-1', status: 'waiting', revision: 1 };
const CREATE_BODY = {
  proposalKey: 'job1:call1',
  requesterKey: 'user:sara',
  conversationKey: 'dm:sara:nora',
  toolName: 'create_issue',
  heading: 'changesThings',
  toolFingerprint: 'fp-1',
  policyRevision: 2,
  arguments: { title: 'x' },
};

beforeEach(() => {
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  for (const name of MOCKED) mocks[name].mockReset();
  mocks.createRequest.mockResolvedValue({ action: ACTION, created: true });
  mocks.readRequest.mockResolvedValue(ACTION);
  mocks.decide.mockResolvedValue({ outcome: 'decided', action: ACTION, grantId: null });
  mocks.claim.mockResolvedValue({ claimed: true, action: ACTION, attemptId: 'att-1', attemptNo: 1, idempotencyKey: 'act-1' });
  mocks.finishAttempt.mockResolvedValue(ACTION);
  mocks.reconcile.mockResolvedValue(ACTION);
  mocks.supersedeWaiting.mockResolvedValue({ closed: ['act-1'] });
  mocks.sweep.mockResolvedValue({ expired: 0, stale: 0, unconfirmed: 0 });
  mocks.findGrant.mockResolvedValue(null);
  mocks.touchGrants.mockResolvedValue({ renewed: 0 });
  mocks.revokeGrants.mockResolvedValue({ revoked: 0 });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const DECIDE_BODY = { actorKey: 'user:sara', revision: 1, decision: 'approve' };
const everything: [string, Handler, string, unknown][] = [
  ['save', CREATE as Handler, 'POST', CREATE_BODY],
  ['read', READ as Handler, 'GET', undefined],
  ['decide', DECIDE as Handler, 'POST', DECIDE_BODY],
  ['claim', CLAIM as Handler, 'POST', {}],
  ['finish', FINISH as Handler, 'POST', { attemptId: 'att-1', outcome: 'succeeded' }],
  ['reconcile', RECONCILE as Handler, 'POST', { outcome: 'succeeded' }],
  ['supersede', SUPERSEDE as Handler, 'POST', { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora' }],
  ['sweep', SWEEP as Handler, 'POST', {}],
  ['find a remembered approval', FIND as Handler, 'POST', { requesterKey: 'user:sara', conversationKey: 'c', toolName: 't', heading: 'changesThings', toolFingerprint: 'f', policyRevision: 1, arguments: {} }],
  ['renew remembered approvals', TOUCH as Handler, 'POST', { requesterKey: 'user:sara', conversationKey: 'c' }],
  ['revoke remembered approvals', REVOKE as Handler, 'POST', { requesterKey: 'user:sara', reason: 'ask_again' }],
];

describe('who may reach saved actions', () => {
  it.each(everything)('%s: 401 without the service token, and nothing is read or saved', async (_name, handler, method, body) => {
    for (const token of [null, 'wrong']) {
      const response = await call(handler, method, body, token);
      expect(response.status).toBe(401);
    }
    for (const name of MOCKED) expect(mocks[name]).not.toHaveBeenCalled();
  });

  it.each(everything)('%s: the admin token is not enough', async (_name, handler, method, body) => {
    process.env.ADMIN_API_TOKEN = 'admin-secret';
    expect((await call(handler, method, body, 'admin-secret')).status).toBe(401);
  });

  it.each(everything)('%s: works with the service token', async (_name, handler, method, body) => {
    expect((await call(handler, method, body)).status).toBeLessThan(300);
  });
});

describe('what each one does', () => {
  it('saves a request: 201 when new, 200 when the key was already saved', async () => {
    expect((await call(CREATE as Handler, 'POST', CREATE_BODY)).status).toBe(201);
    expect(mocks.createRequest).toHaveBeenCalledWith('bot-1', expect.objectContaining({ proposalKey: 'job1:call1', arguments: { title: 'x' } }));
    mocks.createRequest.mockResolvedValue({ action: ACTION, created: false });
    expect((await call(CREATE as Handler, 'POST', CREATE_BODY)).status).toBe(200);
  });

  it.each([
    ['not an object', 'nope'],
    ['no arguments', { ...CREATE_BODY, arguments: undefined }],
    ['an unknown heading', { ...CREATE_BODY, heading: 'sends' }],
    ['a field it does not know', { ...CREATE_BODY, extra: 1 }],
    ['a bad remember scope', { ...CREATE_BODY, rememberScope: { fixed: {} } }],
  ])('refuses to save %s with a 400', async (_name, body) => {
    expect((await call(CREATE as Handler, 'POST', body)).status).toBe(400);
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it('answers a tap that won with 200 and one that lost with 409 and what happened', async () => {
    const won = await call(DECIDE as Handler, 'POST', DECIDE_BODY);
    expect(won.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith('bot-1', 'act-1', DECIDE_BODY);

    mocks.decide.mockResolvedValue({ outcome: 'already_decided', action: { ...ACTION, status: 'approved' } });
    const lost = await call(DECIDE as Handler, 'POST', DECIDE_BODY);
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ outcome: 'already_decided', action: { status: 'approved' } });

    mocks.decide.mockResolvedValue({ outcome: 'expired', action: { ...ACTION, status: 'closed' } });
    expect((await call(DECIDE as Handler, 'POST', DECIDE_BODY)).status).toBe(409);
  });

  it('takes nothing but the choice with a tap: no new content', async () => {
    for (const body of [{ ...DECIDE_BODY, arguments: { title: 'other' } }, { ...DECIDE_BODY, decision: 'edit' }, { actorKey: 'user:sara', decision: 'approve' }]) {
      expect((await call(DECIDE as Handler, 'POST', body)).status).toBe(400);
    }
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('answers a claim that won with 200 and one that lost with 409', async () => {
    expect((await call(CLAIM as Handler, 'POST', {})).status).toBe(200);
    mocks.claim.mockResolvedValue({ claimed: false, reason: 'couldntConfirm', action: ACTION });
    const lost = await call(CLAIM as Handler, 'POST', undefined);
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ claimed: false, reason: 'couldntConfirm' });
  });

  it('passes on a failure it can explain, and reports one it cannot', async () => {
    mocks.decide.mockRejectedValue(new lib.BotActionError(403, 'not_requester', 'Only the person who asked can answer'));
    const refused = await call(DECIDE as Handler, 'POST', DECIDE_BODY);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Only the person who asked can answer', code: 'not_requester' });

    mocks.decide.mockRejectedValue(new Error('database is down'));
    const broken = await call(DECIDE as Handler, 'POST', DECIDE_BODY);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: 'Failed saving the decision' });
  });

  it.each([
    ['an outcome it does not know', FINISH, { attemptId: 'a', outcome: 'maybe' }],
    ['reconciling to unknown', RECONCILE, { outcome: 'uncertain' }],
    ['a revoke reason it does not know', REVOKE, { requesterKey: 'u', reason: 'because' }],
  ])('refuses %s with a 400', async (_name, handler, body) => {
    expect((await call(handler as Handler, 'POST', body)).status).toBe(400);
  });
});
