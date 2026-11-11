/**
 * The routes of the Brick for guests (game #1997). The three the bot server calls answer to its service token and to
 * nobody else, a guest, a host and a super admin included. The one a person calls after signing in answers only a signed-in
 * person, and only about themselves. What they do is in guest-brick-db.test.ts, against a real database.
 */
import { NextRequest } from 'next/server';
import { GET as getBrick } from '@/app/api/guest-brick/route';
import { POST as claimReply } from '@/app/api/guest-brick/replies/route';
import { PATCH as finishReply } from '@/app/api/guest-brick/replies/[turnId]/route';
import { POST as takeChat } from '@/app/api/bricks/default/guest-chat/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { GuestBrickError, claimGuestBrickReply, finishGuestBrickReply, guestBrickFor, takeCarriedGuestChat } from '@/lib/guest-brick';

jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/guest-brick', () => ({
  ...jest.requireActual('@/lib/guest-brick'),
  guestBrickFor: jest.fn(),
  claimGuestBrickReply: jest.fn(),
  finishGuestBrickReply: jest.fn(),
  takeCarriedGuestChat: jest.fn(),
}));

const user = prisma.user as unknown as { findUnique: jest.Mock };
const session = getSessionUser as jest.Mock;
const served = guestBrickFor as jest.Mock;
const claim = claimGuestBrickReply as jest.Mock;
const finish = finishGuestBrickReply as jest.Mock;
const take = takeCarriedGuestChat as jest.Mock;

const TOKEN = 'bot-server-secret';
const asBotServer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const call = (path: string, method: string, headers: Record<string, string> = asBotServer, body?: unknown) =>
  new NextRequest(`http://localhost:3333${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(() => {
  process.env.BOT_SERVICE_TOKEN = TOKEN;
});
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('what the bot server calls', () => {
  const doors: [string, () => Promise<Response>][] = [
    ['reading the Brick for guests', () => getBrick(call('/api/guest-brick?roomUrl=x', 'GET', {}))],
    ['asking for a reply', () => claimReply(call('/api/guest-brick/replies', 'POST', {}, { guestId: 'g', turnId: 't' }))],
    ['closing a turn', () => finishReply(call('/api/guest-brick/replies/t', 'PATCH', {}, { failed: true }), { params: Promise.resolve({ turnId: 't' }) })],
  ];

  it.each(doors)('turns down anyone without the service token: %s', async (_name, door) => {
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com', name: 'Root' });
    expect((await door()).status).toBe(401);
    expect(served).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('turns down a wrong token', async () => {
    expect((await getBrick(call('/api/guest-brick', 'GET', { authorization: 'Bearer nope' }))).status).toBe(401);
  });

  it('serves the Brick for the room it is asked about', async () => {
    served.mockResolvedValue({ brick: { name: 'Brick' }, place: { universeKey: 'u1' }, credentials: { source: 'universe-ai' } });
    const response = await getBrick(call('/api/guest-brick?roomUrl=https%3A%2F%2Fplay.example%2F%40%2Fa%2Fb%2Fc', 'GET'));
    expect(response.status).toBe(200);
    expect(served).toHaveBeenCalledWith('https://play.example/@/a/b/c');
    expect(await response.json()).toMatchObject({ brick: { name: 'Brick' }, credentials: { source: 'universe-ai' } });
  });

  it('says 503 with the reason when Universe AI has no provider', async () => {
    served.mockRejectedValue(new GuestBrickError('Universe AI has no enabled provider.', 503));
    const response = await getBrick(call('/api/guest-brick', 'GET'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Universe AI has no enabled provider.' });
  });

  it('answers whether a reply is allowed, and says which allowance stopped it', async () => {
    claim.mockResolvedValueOnce({ allowed: true, turnId: 't1', counted: true });
    claim.mockResolvedValueOnce({ allowed: false, limit: 'universe', resetsAt: '2026-11-12T01:00:00.000Z' });
    const body = { guestId: 'g1', turnId: 't1', roomUrl: 'https://play.example/@/a/b/c' };
    const ok = await claimReply(call('/api/guest-brick/replies', 'POST', asBotServer, body));
    expect(await ok.json()).toEqual({ allowed: true, turnId: 't1', counted: true });
    expect(claim).toHaveBeenCalledWith(body);
    const no = await claimReply(call('/api/guest-brick/replies', 'POST', asBotServer, body));
    expect(no.status).toBe(200);
    expect(await no.json()).toEqual({ allowed: false, limit: 'universe', resetsAt: '2026-11-12T01:00:00.000Z' });
  });

  it('turns down a body that is not an object, and a turn that is another guest’s', async () => {
    const bad = await claimReply(new NextRequest('http://localhost:3333/api/guest-brick/replies', { method: 'POST', headers: asBotServer, body: '[1]' }));
    expect(bad.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
    claim.mockRejectedValue(new GuestBrickError('turnId belongs to another guest', 409));
    expect((await claimReply(call('/api/guest-brick/replies', 'POST', asBotServer, { guestId: 'g', turnId: 't' }))).status).toBe(409);
  });

  it('closes a turn, and says 404 for one it never counted', async () => {
    finish.mockResolvedValueOnce({ turnId: 't1', failed: true });
    const done = await finishReply(call('/api/guest-brick/replies/t1', 'PATCH', asBotServer, { failed: true }), { params: Promise.resolve({ turnId: 't1' }) });
    expect(await done.json()).toEqual({ turnId: 't1', failed: true });
    expect(finish).toHaveBeenCalledWith('t1', { failed: true });
    finish.mockRejectedValueOnce(new GuestBrickError('Reply not found', 404));
    expect((await finishReply(call('/api/guest-brick/replies/zz', 'PATCH', asBotServer, {}), { params: Promise.resolve({ turnId: 'zz' }) })).status).toBe(404);
  });

  it('says 500 without the details when something breaks', async () => {
    claim.mockRejectedValue(new Error('connection string with a password'));
    const response = await claimReply(call('/api/guest-brick/replies', 'POST', asBotServer, { guestId: 'g', turnId: 't' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('the guest chat a person picks up after signing in', () => {
  const post = (headers: Record<string, string>, body?: unknown) => takeChat(call('/api/bricks/default/guest-chat', 'POST', headers, body));

  it('answers for the guest id the device held, for the person who signed in', async () => {
    session.mockResolvedValue({ id: 'u-sara' });
    user.findUnique.mockResolvedValue({ isGuest: false });
    take.mockResolvedValue({ carried: true });
    const response = await post({}, { guestId: 'g-1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ carried: true });
    expect(take).toHaveBeenCalledWith('u-sara', 'g-1');
  });

  it('needs the guest id: a device without one cannot ask', async () => {
    session.mockResolvedValue({ id: 'u-sara' });
    user.findUnique.mockResolvedValue({ isGuest: false });
    expect((await post({}, {})).status).toBe(400);
    expect((await post({}, { guestId: 7 })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(take).not.toHaveBeenCalled();
  });

  it('turns down a guest, and someone not signed in, and gives nothing', async () => {
    session.mockResolvedValue({ id: 'u-guest' });
    user.findUnique.mockResolvedValue({ isGuest: true });
    expect((await post({}, { guestId: 'g-1' })).status).toBe(403);
    session.mockResolvedValue(null);
    expect((await post({}, { guestId: 'g-1' })).status).toBe(401);
    // The service token is no way in: this one is about a person's own account
    expect((await post(asBotServer, { guestId: 'g-1' })).status).toBe(401);
    expect(take).not.toHaveBeenCalled();
  });
});
