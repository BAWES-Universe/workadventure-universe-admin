/**
 * A saved record for each bot action that waits for a tap (#739): a double tap and two devices give one decision, an
 * approval nobody starts goes stale, and a run marked couldn't confirm can't be claimed again.
 *
 * The rules run against an in-memory stand-in for the database (__tests__/helpers/bot-actions-db.ts). The same scenarios
 * run on a real Postgres with:  BOT_ACTIONS_REAL_DB=1 DATABASE_URL=postgresql://... npx jest __tests__/lib/bot-actions.test.ts
 * (a database with the migrations applied; it empties the action tables first).
 */
import {
  BotActionError,
  DEFAULTS,
  argumentsFitScope,
  canonicalJson,
  claim,
  createRequest,
  decide,
  digestOf,
  finishAttempt,
  findGrant,
  readRequest,
  reconcile,
  revokeGrants,
  supersedeWaiting,
  sweep,
  touchGrants,
  type CreateRequestInput,
} from '@/lib/bot-actions';
import { prisma } from '@/lib/db';
import { db } from '../helpers/bot-actions-db';

const REAL = !!process.env.BOT_ACTIONS_REAL_DB;

jest.mock('@/lib/db', () =>
  process.env.BOT_ACTIONS_REAL_DB ? jest.requireActual('@/lib/db') : { prisma: jest.requireActual('../helpers/bot-actions-db').fakePrisma },
);

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

const BOT = 'bot-1';
const T0 = new Date('2026-10-30T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const minutes = (n: number) => n * 60;

const ISSUE = { title: 'Fix the login page', description: 'It fails on Safari', team: 'WEB' };

function input(extra: Partial<CreateRequestInput> = {}): CreateRequestInput {
  return {
    proposalKey: 'job1:turn1:call1',
    requesterKey: 'user:sara',
    conversationKey: 'dm:sara:nora',
    connectionRef: 'linear:acme',
    toolName: 'create_issue',
    heading: 'changesThings',
    toolFingerprint: 'fp-1',
    policyRevision: 3,
    arguments: ISSUE,
    ...extra,
  };
}

async function reset() {
  if (REAL) {
    const sql = prisma as unknown as { $executeRawUnsafe(query: string): Promise<number> };
    await sql.$executeRawUnsafe('TRUNCATE bot_action_requests, bot_action_grants CASCADE');
    await sql.$executeRawUnsafe(`
      INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()) ON CONFLICT DO NOTHING;
      INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now()) ON CONFLICT DO NOTHING;
      INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now()) ON CONFLICT DO NOTHING;
      INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now()) ON CONFLICT DO NOTHING;
      INSERT INTO bots (id, room_id, name, updated_at) VALUES ('${BOT}', 'room1', 'Nora', now()) ON CONFLICT DO NOTHING;`);
  } else {
    db.reset();
    db.bots.push({ id: BOT });
  }
}

beforeEach(reset);
afterAll(async () => {
  if (REAL) await (prisma as unknown as { $disconnect(): Promise<void> }).$disconnect();
});

async function waiting(extra: Partial<CreateRequestInput> = {}, now = T0) {
  return (await createRequest(BOT, input(extra), now)).action;
}

/** A request that was approved at T0 and is waiting for a dispatcher. */
async function approved(extra: Partial<CreateRequestInput> = {}) {
  const request = await waiting(extra);
  const result = await decide(BOT, request.id, { actorKey: request.requesterKey, revision: request.revision, decision: 'approve' }, T0);
  if (result.outcome !== 'decided') throw new Error('expected the approval to win');
  return result.action;
}

/** A request a dispatcher has claimed and is running. */
async function running() {
  const request = await approved();
  const claimed = await claim(BOT, request.id, {}, at(5));
  if (!claimed.claimed) throw new Error('expected the claim to win');
  return { request: claimed.action, attemptId: claimed.attemptId };
}

const failsWith = async (promise: Promise<unknown>, status: number, code: string) => {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(BotActionError);
  expect(error).toMatchObject({ status, code });
};

describe('saving a request', () => {
  it('waits for a tap, with the arguments exactly as shown and a time to answer', async () => {
    const { action, created } = await createRequest(BOT, input(), T0);
    expect(created).toBe(true);
    expect(action).toMatchObject({ status: 'waiting', revision: 1, closedReason: null, toolName: 'create_issue', heading: 'changesThings' });
    expect(action.arguments).toEqual(ISSUE);
    expect(action.reviewExpiresAt).toEqual(at(minutes(DEFAULTS.reviewMinutes)));
    expect((await readRequest(BOT, action.id, at(1))).arguments).toEqual(ISSUE);
  });

  it('takes the time to answer from the caller, so a bot’s own "A card waits" setting can be used', async () => {
    const action = await waiting({ reviewMinutes: 30 });
    expect(action.reviewExpiresAt).toEqual(at(minutes(30)));
  });

  it('does not keep the card text in the clear', async () => {
    await waiting();
    if (!REAL) expect(JSON.stringify(db.requests)).not.toContain('Fix the login page');
  });

  it('gives back the request already saved for the same key, so a restart makes no second card', async () => {
    const first = await createRequest(BOT, input(), T0);
    const again = await createRequest(BOT, input(), at(5));
    expect(again.created).toBe(false);
    expect(again.action.id).toBe(first.action.id);
    if (!REAL) expect(db.requests).toHaveLength(1);
  });

  it('makes one request when the same key is saved twice at once', async () => {
    const [a, b] = await Promise.all([createRequest(BOT, input(), T0), createRequest(BOT, input(), T0)]);
    expect(a.action.id).toBe(b.action.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('refuses the same key for a different action', async () => {
    await createRequest(BOT, input(), T0);
    await failsWith(createRequest(BOT, input({ arguments: { ...ISSUE, title: 'Something else' } }), T0), 409, 'proposal_key_reused');
    await failsWith(createRequest(BOT, input({ requesterKey: 'user:omar' }), T0), 409, 'proposal_key_reused');
  });

  it('refuses the same key when the card changed: its heading, conversation, tool, policy or what may be remembered', async () => {
    const first = await createRequest(BOT, input({ rememberScope: { fixed: { team: 'WEB' }, varies: ['title'] } }), T0);
    const same: Partial<CreateRequestInput> = { rememberScope: { fixed: { team: 'WEB' }, varies: ['title'] } };
    for (const changed of [
      { heading: 'makesNew' as const },
      { conversationKey: 'dm:omar:nora' },
      { toolFingerprint: 'fp-2' },
      { policyRevision: 4 },
      { rememberScope: null },
      { rememberScope: { fixed: { team: 'OPS' }, varies: ['title'] } },
    ]) {
      await failsWith(createRequest(BOT, input({ ...same, ...changed }), at(1)), 409, 'proposal_key_reused');
    }
    const again = await createRequest(BOT, input(same), at(2));
    expect(again).toMatchObject({ created: false, action: { id: first.action.id } });
    if (!REAL) expect(db.requests).toHaveLength(1);
  });

  it('refuses a bot that is not there', async () => {
    await failsWith(createRequest('nope', input(), T0), 404, 'bot_not_found');
  });

  it('never offers to remember a delete or a send', async () => {
    await failsWith(
      createRequest(BOT, input({ heading: 'deletesOrSends', toolName: 'send_email', rememberScope: { fixed: {}, varies: ['body'] } }), T0),
      400,
      'remember_not_allowed',
    );
  });
});

describe('a tap', () => {
  it('approves: the action is approved and must start within the start window', async () => {
    const request = await waiting();
    const result = await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve' }, at(10));
    expect(result.outcome).toBe('decided');
    expect(result.action).toMatchObject({ status: 'approved', revision: 2, approvedAt: at(10), startBy: at(10 + DEFAULTS.startWithinSeconds) });
  });

  it('declines: nothing can start', async () => {
    const request = await waiting();
    const result = await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'decline' }, at(10));
    expect(result.action).toMatchObject({ status: 'closed', closedReason: 'declined', finishedAt: at(10) });
    const claimed = await claim(BOT, request.id, {}, at(11));
    expect(claimed).toMatchObject({ claimed: false, reason: 'closed' });
  });

  it('is only the asker’s to make', async () => {
    const request = await waiting();
    await failsWith(decide(BOT, request.id, { actorKey: 'user:omar', revision: 1, decision: 'approve' }, at(1)), 403, 'not_requester');
    expect((await readRequest(BOT, request.id, at(2))).status).toBe('waiting');
  });

  it('is a double tap that gives one decision', async () => {
    const request = await waiting();
    const tap = () => decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve' }, at(10));
    const results = await Promise.all([tap(), tap()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['already_decided', 'decided']);
    for (const result of results) expect(result.action.status).toBe('approved');
    if (!REAL) expect(db.decisions.filter((d) => d.event === 'approve')).toHaveLength(1);
  });

  it('is two devices that disagree: one choice wins and the other is told what happened', async () => {
    const request = await waiting();
    const [phone, laptop] = await Promise.all([
      decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve' }, at(10)),
      decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'decline' }, at(10)),
    ]);
    expect([phone.outcome, laptop.outcome].filter((o) => o === 'decided')).toHaveLength(1);
    expect(phone.action.status).toBe(laptop.action.status);
    expect(['approved', 'closed']).toContain(phone.action.status);
    if (!REAL) expect(db.decisions.filter((d) => d.event === 'approve' || d.event === 'decline')).toHaveLength(1);
  });

  it('is turned away when it carries a revision that is no longer the card’s', async () => {
    const request = await waiting();
    await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve' }, at(10));
    const late = await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'decline' }, at(11));
    expect(late.outcome).toBe('already_decided');
    expect(late.action.status).toBe('approved');
  });

  it('is turned away after the card’s time, by the server clock', async () => {
    const request = await waiting();
    const result = await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve' }, at(minutes(DEFAULTS.reviewMinutes) + 1));
    expect(result.outcome).toBe('expired');
    expect(result.action).toMatchObject({ status: 'closed', closedReason: 'expired' });
  });

  it('cannot remember on a card that did not offer it', async () => {
    const request = await waiting();
    await failsWith(decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approveAndRemember' }, at(1)), 400, 'remember_not_offered');
    expect((await readRequest(BOT, request.id, at(2))).status).toBe('waiting');
  });
});

describe('starting an approved action', () => {
  it('lets one dispatcher claim it, with one attempt and a stable key', async () => {
    const request = await approved();
    const claimed = await claim(BOT, request.id, {}, at(5));
    expect(claimed).toMatchObject({ claimed: true, attemptNo: 1, idempotencyKey: request.id });
    expect(claimed.action).toMatchObject({ status: 'running' });
    expect(claimed.action.attempts).toHaveLength(1);
  });

  it('gives the claim to only one of two dispatchers', async () => {
    const request = await approved();
    const results = await Promise.all([claim(BOT, request.id, {}, at(5)), claim(BOT, request.id, {}, at(5))]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const lost = results.find((r) => !r.claimed);
    expect(lost).toMatchObject({ claimed: false });
    expect((await readRequest(BOT, request.id, at(6))).attempts).toHaveLength(1);
  });

  it('makes an approval nobody started stale after the start window, needing a fresh card', async () => {
    const request = await approved();
    const late = await claim(BOT, request.id, {}, at(DEFAULTS.startWithinSeconds + 1));
    expect(late).toMatchObject({ claimed: false, reason: 'stale' });
    expect(late.action).toMatchObject({ status: 'closed', closedReason: 'stale' });
    expect(late.action.attempts).toHaveLength(0);
    // It stays stale: a later claim does not revive it
    expect(await claim(BOT, request.id, {}, at(5))).toMatchObject({ claimed: false, reason: 'closed' });
  });

  it('still starts just inside the window', async () => {
    const request = await approved();
    expect((await claim(BOT, request.id, {}, at(DEFAULTS.startWithinSeconds - 1))).claimed).toBe(true);
  });

  it('cannot start an action that is still waiting for a tap', async () => {
    const request = await waiting();
    expect(await claim(BOT, request.id, {}, at(1))).toMatchObject({ claimed: false, reason: 'waiting' });
  });

  it('can be told to use a different start window', async () => {
    const request = await waiting();
    const result = await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve', startWithinSeconds: 5 }, T0);
    expect(result.action.startBy).toEqual(at(5));
  });
});

describe('how a run ended', () => {
  it('succeeded is done and stays done', async () => {
    const { request, attemptId } = await running();
    const done = await finishAttempt(BOT, request.id, { attemptId, outcome: 'succeeded', providerRequestId: 'lin-1' }, at(8));
    expect(done).toMatchObject({ status: 'done', finishedAt: at(8) });
    expect(done.attempts[0]).toMatchObject({ state: 'succeeded', providerRequestId: 'lin-1' });
    expect(await claim(BOT, request.id, {}, at(9))).toMatchObject({ claimed: false, reason: 'done' });
  });

  it('failed is failed, and is not run again on its own', async () => {
    const { request, attemptId } = await running();
    expect((await finishAttempt(BOT, request.id, { attemptId, outcome: 'failed', outcomeClass: 'rejected' }, at(8))).status).toBe('failed');
    expect(await claim(BOT, request.id, {}, at(9))).toMatchObject({ claimed: false, reason: 'failed' });
  });

  it('not sent goes back to approved while there is time, with the same key for the next try', async () => {
    const { request, attemptId } = await running();
    const back = await finishAttempt(BOT, request.id, { attemptId, outcome: 'notSent' }, at(8));
    expect(back.status).toBe('approved');
    const again = await claim(BOT, request.id, {}, at(10));
    expect(again).toMatchObject({ claimed: true, attemptNo: 2, idempotencyKey: request.id });
  });

  it('not sent after the start window is stale, not tried late', async () => {
    const { request, attemptId } = await running();
    const late = await finishAttempt(BOT, request.id, { attemptId, outcome: 'notSent' }, at(DEFAULTS.startWithinSeconds + 5));
    expect(late).toMatchObject({ status: 'closed', closedReason: 'stale' });
  });

  it('refuses a second answer for the same attempt, and an attempt that is not there', async () => {
    const { request, attemptId } = await running();
    await finishAttempt(BOT, request.id, { attemptId, outcome: 'succeeded' }, at(8));
    await failsWith(finishAttempt(BOT, request.id, { attemptId, outcome: 'failed' }, at(9)), 409, 'not_running');
    await failsWith(finishAttempt(BOT, request.id, { attemptId: 'nope', outcome: 'failed' }, at(9)), 404, 'attempt_not_found');
  });
});

describe('a run we could not confirm', () => {
  async function unconfirmed() {
    const { request, attemptId } = await running();
    const view = await finishAttempt(BOT, request.id, { attemptId, outcome: 'uncertain', outcomeClass: 'timeout' }, at(8));
    expect(view.status).toBe('couldntConfirm');
    return view;
  }

  it('cannot be claimed again, however long it waits', async () => {
    const view = await unconfirmed();
    for (const seconds of [9, 20, 60, 3600]) {
      expect(await claim(BOT, view.id, {}, at(seconds))).toMatchObject({ claimed: false, reason: 'couldntConfirm' });
    }
    expect((await readRequest(BOT, view.id, at(3600))).attempts).toHaveLength(1);
  });

  it('is not changed by housekeeping, a tap, or a new approval', async () => {
    const view = await unconfirmed();
    await sweep(BOT, at(7200));
    const tap = await decide(BOT, view.id, { actorKey: 'user:sara', revision: view.revision, decision: 'approve' }, at(7201));
    expect(tap.outcome).toBe('already_decided');
    expect((await readRequest(BOT, view.id, at(7202))).status).toBe('couldntConfirm');
  });

  it('is settled only by what is found at the destination, and is then never run again', async () => {
    const view = await unconfirmed();
    expect((await reconcile(BOT, view.id, { outcome: 'succeeded' }, at(100))).status).toBe('done');
    expect(await claim(BOT, view.id, {}, at(101))).toMatchObject({ claimed: false, reason: 'done' });
    await failsWith(reconcile(BOT, view.id, { outcome: 'failed' }, at(102)), 409, 'not_unconfirmed');
  });

  it('can be settled as failed', async () => {
    const view = await unconfirmed();
    expect((await reconcile(BOT, view.id, { outcome: 'failed' }, at(100))).status).toBe('failed');
  });

  it('is what a run becomes when its dispatcher disappeared, never a repeat', async () => {
    const { request } = await running();
    const early = await sweep(BOT, at(5 + DEFAULTS.leaseSeconds - 1));
    expect(early.unconfirmed).toBe(0);
    expect((await readRequest(BOT, request.id, at(30))).status).toBe('running');

    const swept = await sweep(BOT, at(5 + DEFAULTS.leaseSeconds + 1));
    expect(swept.unconfirmed).toBe(1);
    const view = await readRequest(BOT, request.id, at(300));
    expect(view.status).toBe('couldntConfirm');
    expect(view.attempts[0]).toMatchObject({ state: 'uncertain', outcomeClass: 'lease_expired' });
    expect(await claim(BOT, request.id, {}, at(301))).toMatchObject({ claimed: false, reason: 'couldntConfirm' });
  });

  it('keeps the dispatcher’s own late answer from overwriting it', async () => {
    const { request, attemptId } = await running();
    await sweep(BOT, at(5 + DEFAULTS.leaseSeconds + 1));
    await failsWith(finishAttempt(BOT, request.id, { attemptId, outcome: 'succeeded' }, at(400)), 409, 'not_running');
  });
});

describe('housekeeping', () => {
  it('closes cards that waited too long and approvals nobody started', async () => {
    const old = await waiting({ proposalKey: 'k-old' });
    const unstarted = await approved({ proposalKey: 'k-unstarted' });
    const fresh = await waiting({ proposalKey: 'k-fresh' }, at(minutes(DEFAULTS.reviewMinutes)));
    const swept = await sweep(BOT, at(minutes(DEFAULTS.reviewMinutes) + 1));
    expect(swept).toMatchObject({ expired: 1, stale: 1, unconfirmed: 0 });
    expect(await readRequest(BOT, old.id, at(minutes(DEFAULTS.reviewMinutes) + 1))).toMatchObject({ status: 'closed', closedReason: 'expired' });
    expect(await readRequest(BOT, unstarted.id, at(minutes(DEFAULTS.reviewMinutes) + 1))).toMatchObject({ status: 'closed', closedReason: 'stale' });
    expect((await readRequest(BOT, fresh.id, at(minutes(DEFAULTS.reviewMinutes) + 1))).status).toBe('waiting');
  });

  it('reading a request closes it if its time has run out', async () => {
    const request = await waiting();
    expect(await readRequest(BOT, request.id, at(minutes(DEFAULTS.reviewMinutes) + 1))).toMatchObject({ status: 'closed', closedReason: 'expired' });
  });

  it('can be run again without changing anything', async () => {
    await waiting();
    await sweep(BOT, at(minutes(DEFAULTS.reviewMinutes) + 1));
    expect(await sweep(BOT, at(minutes(DEFAULTS.reviewMinutes) + 2))).toEqual({ expired: 0, stale: 0, unconfirmed: 0 });
  });
});

describe('a replacement instruction', () => {
  it('closes the asker’s waiting and approved-not-started actions in that conversation, and nothing else', async () => {
    const mine = await waiting({ proposalKey: 'k1' });
    const mineApproved = await approved({ proposalKey: 'k2' });
    const otherPerson = await waiting({ proposalKey: 'k3', requesterKey: 'user:omar' });
    const otherChat = await waiting({ proposalKey: 'k4', conversationKey: 'dm:sara:atlas' });
    const { request: inFlight } = await (async () => {
      const r = await approved({ proposalKey: 'k5' });
      const c = await claim(BOT, r.id, {}, at(3));
      if (!c.claimed) throw new Error('claim');
      return { request: c.action };
    })();

    const { closed } = await supersedeWaiting(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora' }, at(4));
    expect(closed.sort()).toEqual([mine.id, mineApproved.id].sort());
    expect((await readRequest(BOT, mine.id, at(5))).closedReason).toBe('superseded');
    expect((await readRequest(BOT, otherPerson.id, at(5))).status).toBe('waiting');
    expect((await readRequest(BOT, otherChat.id, at(5))).status).toBe('waiting');
    expect((await readRequest(BOT, inFlight.id, at(5))).status).toBe('running');
  });

  it('wins or loses cleanly against a tap that arrives at the same time', async () => {
    const request = await waiting();
    const [tap, replaced] = await Promise.all([
      decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approve' }, at(5)),
      supersedeWaiting(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora' }, at(5)),
    ]);
    const view = await readRequest(BOT, request.id, at(6));
    if (tap.outcome === 'decided') {
      // The approval won: the replacement then closed it before it started, or it is still waiting to start
      expect(['approved', 'closed']).toContain(view.status);
    } else {
      expect(replaced.closed).toEqual([request.id]);
      expect(view).toMatchObject({ status: 'closed', closedReason: 'superseded' });
    }
  });
});

describe('remembered approvals', () => {
  const SCOPE = { fixed: { team: 'WEB' }, varies: ['title', 'description'] };
  const lookup = (extra: Record<string, unknown> = {}) => ({
    requesterKey: 'user:sara',
    conversationKey: 'dm:sara:nora',
    connectionRef: 'linear:acme',
    toolName: 'create_issue',
    heading: 'changesThings' as const,
    toolFingerprint: 'fp-1',
    policyRevision: 3,
    arguments: { title: 'Another one', description: 'Something else', team: 'WEB' },
    ...extra,
  });

  async function remembered() {
    const request = await waiting({ rememberScope: SCOPE });
    const result = await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approveAndRemember' }, T0);
    if (result.outcome !== 'decided') throw new Error('expected the approval to win');
    return result;
  }

  it('is saved with the approval, and covers the same kind of action with different titles', async () => {
    const result = await remembered();
    expect(result.action.status).toBe('approved');
    expect(result.grantId).toEqual(expect.any(String));
    const found = await findGrant(BOT, lookup(), at(60));
    expect(found).toMatchObject({ grantId: result.grantId, scope: SCOPE });
  });

  it('does not cover another team, an extra field, another person, chat, connection, tool, policy or heading', async () => {
    await remembered();
    const no = async (extra: Record<string, unknown>) => expect(await findGrant(BOT, lookup(extra), at(60))).toBeNull();
    await no({ arguments: { title: 'x', team: 'OPS' } });
    await no({ arguments: { title: 'x', team: 'WEB', assignee: 'omar' } });
    await no({ arguments: { title: 'x' } });
    await no({ requesterKey: 'user:omar' });
    await no({ conversationKey: 'dm:sara:atlas' });
    await no({ connectionRef: 'linear:other' });
    await no({ connectionRef: null });
    await no({ toolName: 'edit_issue' });
    await no({ toolFingerprint: 'fp-2' });
    await no({ policyRevision: 4 });
    await no({ heading: 'makesNew' });
  });

  it('never covers deleting or sending', async () => {
    await remembered();
    expect(await findGrant(BOT, lookup({ heading: 'deletesOrSends' }), at(60))).toBeNull();
  });

  it('ends after the idle time without the asker’s messages, and the asker’s messages keep it going', async () => {
    await remembered();
    expect(await findGrant(BOT, lookup(), at(minutes(DEFAULTS.idleMinutes) - 1))).not.toBeNull();
    expect(await findGrant(BOT, lookup(), at(minutes(DEFAULTS.idleMinutes) + 1))).toBeNull();

    // A message at 50 minutes keeps it going another idle period
    expect((await touchGrants(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora' }, at(minutes(50)))).renewed).toBe(1);
    expect(await findGrant(BOT, lookup(), at(minutes(100)))).not.toBeNull();
    expect(await findGrant(BOT, lookup(), at(minutes(111)))).toBeNull();
  });

  it('ends at the absolute time even when the conversation stays busy', async () => {
    await remembered();
    for (let m = 50; m < DEFAULTS.absoluteMinutes; m += 50) {
      await touchGrants(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora' }, at(minutes(m)));
    }
    expect(await findGrant(BOT, lookup(), at(minutes(DEFAULTS.absoluteMinutes) - 1))).not.toBeNull();
    expect(await findGrant(BOT, lookup(), at(minutes(DEFAULTS.absoluteMinutes) + 1))).toBeNull();
    expect((await touchGrants(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora' }, at(minutes(DEFAULTS.absoluteMinutes) + 2))).renewed).toBe(0);
  });

  it('is not renewed by someone else’s message or another chat', async () => {
    await remembered();
    expect((await touchGrants(BOT, { requesterKey: 'user:omar', conversationKey: 'dm:sara:nora' }, at(minutes(50)))).renewed).toBe(0);
    expect((await touchGrants(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:atlas' }, at(minutes(50)))).renewed).toBe(0);
  });

  it('can be asked-again, and leaving ends it and closes what was still waiting', async () => {
    await remembered();
    expect((await revokeGrants(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora', reason: 'ask_again' }, at(30))).revoked).toBe(1);
    expect(await findGrant(BOT, lookup(), at(31))).toBeNull();

    const pending = await waiting({ proposalKey: 'k-later' }, at(40));
    await revokeGrants(BOT, { requesterKey: 'user:sara', conversationKey: 'dm:sara:nora', reason: 'left' }, at(41));
    expect(await readRequest(BOT, pending.id, at(42))).toMatchObject({ status: 'closed', closedReason: 'revoked' });
  });

  it('takes the idle and absolute times from the caller', async () => {
    const request = await waiting({ rememberScope: SCOPE });
    await decide(BOT, request.id, { actorKey: 'user:sara', revision: 1, decision: 'approveAndRemember', idleMinutes: 5, absoluteMinutes: 20 }, T0);
    expect(await findGrant(BOT, lookup(), at(minutes(4)))).not.toBeNull();
    expect(await findGrant(BOT, lookup(), at(minutes(6)))).toBeNull();
  });
});

describe('pieces', () => {
  it('writes the same JSON for the same arguments whatever order the keys come in', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { c: undefined, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(digestOf('t', null, { a: 1, b: 2 })).toBe(digestOf('t', null, { b: 2, a: 1 }));
    expect(digestOf('t', null, { a: 1 })).not.toBe(digestOf('t', 'conn', { a: 1 }));
    expect(digestOf('t', null, { a: 1 })).not.toBe(digestOf('u', null, { a: 1 }));
  });

  it('fits arguments to what was remembered', () => {
    const scope = { fixed: { team: 'WEB', labels: ['a', 'b'] }, varies: ['title'] };
    expect(argumentsFitScope({ team: 'WEB', labels: ['a', 'b'], title: 'x' }, scope)).toBe(true);
    expect(argumentsFitScope({ labels: ['a', 'b'], team: 'WEB' }, scope)).toBe(true);
    expect(argumentsFitScope({ team: 'WEB', labels: ['b', 'a'] }, scope)).toBe(false);
    expect(argumentsFitScope({ team: 'WEB', labels: ['a', 'b'], other: 1 }, scope)).toBe(false);
    expect(argumentsFitScope({ team: 'WEB' }, scope)).toBe(false);
    expect(argumentsFitScope(null, scope)).toBe(false);
    expect(argumentsFitScope([], scope)).toBe(false);
  });
});
