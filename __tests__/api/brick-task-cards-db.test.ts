/**
 * Cards that a goal or task puts up (game #2002, Brick 11) against a real database. They live in the goal's own conversation,
 * `task:{itemId}`, never the chat's; they wait as long as a super admin set ("Scheduled card wait"); the same thing asked again on a
 * later check joins the waiting card; and a goal or task that is over has no card left to say yes to. Runs only with ROLES_DB_TEST=yes
 * and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-task-cards-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { prisma } from '@/lib/db';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { changeItem, claimDueRuns, createItem, finishRun, type NewItemInput } from '@/lib/brick-items';
import { BotActionError, createRequest, decide, extendReview, supersedeWaiting, taskConversationKey, type CreateRequestInput } from '@/lib/bot-actions';
import { saveServerLimits } from '@/lib/bot-limits';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const MINUTE = 60 * 1000;
const NOW = new Date('2026-11-13T06:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

let counter = 0;
async function person(name: string) {
  const unique = `${name}-${tag}-${++counter}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  await prisma.userPreference.create({ data: { userId: user.id, key: 'timeZone', value: 'Asia/Kuwait' } });
  const { brick } = await ensureDefaultBrick(user.id);
  return { id: user.id, uuid: user.uuid, brickId: brick!.id };
}

async function goalOf(who: { uuid: string; brickId: string }, over: Partial<NewItemInput> = {}) {
  const answer = await createItem(who.brickId, { userId: who.uuid, kind: 'goal', words: 'Get my visa', outcome: 'Visa issued', cadence: { type: 'every', minutes: 60 }, ...over }, NOW);
  if (!answer.ok) throw new Error(answer.error);
  return answer.item;
}

const card = (who: { uuid: string }, itemId: string, over: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  proposalKey: `run-${randomUUID()}`,
  requesterKey: who.uuid,
  conversationKey: taskConversationKey(itemId),
  connectionRef: 'linear:acme',
  toolName: 'create_issue',
  heading: 'changesThings',
  toolFingerprint: 'fp-1',
  policyRevision: 1,
  arguments: { title: 'Book the appointment' },
  ...over,
});

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BotActionError) return { status: error.status, code: error.code };
    throw error;
  }
  return null;
};

run('goal and task cards, in a real database', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });
  afterEach(async () => {
    await saveServerLimits({ bricks: { scheduledCardWait: null } } as never, 'admin').catch(() => undefined);
  });

  it('waits as long as the super admin set, whatever the bot server says, and a chat card keeps its own wait', async () => {
    const sara = await person('sara');
    const goal = await goalOf(sara);
    const key = card(sara, goal.id, { reviewMinutes: 5 });
    const made = await createRequest(sara.brickId, key, NOW);
    expect(made.created).toBe(true);
    expect(made.action.reviewExpiresAt.getTime() - NOW.getTime()).toBe(1440 * MINUTE);

    await saveServerLimits({ bricks: { scheduledCardWait: 90 } }, 'admin');
    const second = await goalOf(sara, { words: 'Renew my passport' });
    const later = await createRequest(sara.brickId, card(sara, second.id), NOW);
    expect(later.action.reviewExpiresAt.getTime() - NOW.getTime()).toBe(90 * MINUTE);
    // A card already waiting keeps the time it had
    expect((await createRequest(sara.brickId, { ...key, reviewMinutes: undefined }, at(MINUTE))).action.reviewExpiresAt).toEqual(made.action.reviewExpiresAt);

    const chat = await createRequest(sara.brickId, card(sara, goal.id, { conversationKey: 'dm:sara:brick', reviewMinutes: 5 }), NOW);
    expect(chat.action.reviewExpiresAt.getTime() - NOW.getTime()).toBe(5 * MINUTE);
  });

  it('joins a later check of the same thing to the waiting card: no second card, and says it is not new', async () => {
    const sara = await person('sara');
    const goal = await goalOf(sara);
    const first = await createRequest(sara.brickId, card(sara, goal.id), NOW);
    const check = await createRequest(sara.brickId, card(sara, goal.id), at(60 * MINUTE));
    expect(check.created).toBe(false);
    expect(check.action.id).toBe(first.action.id);
    expect(await prisma.botActionRequest.count({ where: { botId: sara.brickId, conversationKey: taskConversationKey(goal.id) } })).toBe(1);

    // Another thing is another card; the same thing under another goal is another card too
    const other = await createRequest(sara.brickId, card(sara, goal.id, { arguments: { title: 'Pay the fee' } }), at(60 * MINUTE));
    expect(other.created).toBe(true);
    const elsewhere = await goalOf(sara, { words: 'Renew my passport' });
    expect((await createRequest(sara.brickId, card(sara, elsewhere.id), at(60 * MINUTE))).created).toBe(true);

    // A card that was answered or ran out is not joined: the next check asks afresh
    await decide(sara.brickId, first.action.id, { actorKey: sara.uuid, revision: first.action.revision, decision: 'decline' }, at(61 * MINUTE));
    expect((await createRequest(sara.brickId, card(sara, goal.id), at(62 * MINUTE))).created).toBe(true);
    const lapsed = await createRequest(sara.brickId, card(sara, goal.id, { arguments: { title: 'Call them' } }), at(62 * MINUTE));
    expect((await createRequest(sara.brickId, card(sara, goal.id, { arguments: { title: 'Call them' } }), at((62 + 1441) * MINUTE))).created).toBe(true);
    expect(lapsed.created).toBe(true);
  });

  it('is only for a going goal or task of this Brick and only for the person it belongs to', async () => {
    const sara = await person('sara');
    const omar = await person('omar');
    const goal = await goalOf(sara);
    expect(await refusal(createRequest(sara.brickId, card(omar, goal.id), NOW))).toEqual({ status: 403, code: 'not_owner' });
    expect(await refusal(createRequest(sara.brickId, card({ uuid: 'nobody' }, goal.id), NOW))).toEqual({ status: 403, code: 'not_owner' });
    expect(await refusal(createRequest(omar.brickId, card(sara, goal.id), NOW))).toEqual({ status: 404, code: 'task_not_found' });
    expect(await refusal(createRequest(sara.brickId, card(sara, randomUUID()), NOW))).toEqual({ status: 404, code: 'task_not_found' });
    expect(await refusal(createRequest(sara.brickId, card(sara, goal.id, { conversationKey: 'task:not-an-id' }), NOW))).toEqual({ status: 400, code: 'task_key_invalid' });
    await changeItem(sara.brickId, goal.id, { userId: sara.uuid, action: 'done', result: 'Done' }, NOW);
    expect(await refusal(createRequest(sara.brickId, card(sara, goal.id), NOW))).toEqual({ status: 404, code: 'task_not_found' });
  });

  it('is not touched by a message in chat, and "More time" gives the same wait', async () => {
    const sara = await person('sara');
    const goal = await goalOf(sara);
    const made = await createRequest(sara.brickId, card(sara, goal.id), NOW);
    // The person's next message in chat replaces the cards of that chat only
    await supersedeWaiting(sara.brickId, { requesterKey: sara.uuid, conversationKey: 'dm:sara:brick' }, at(MINUTE));
    expect((await prisma.botActionRequest.findUnique({ where: { id: made.action.id } }))?.status).toBe('waiting');

    await saveServerLimits({ bricks: { scheduledCardWait: 120 } }, 'admin');
    const more = await extendReview(sara.brickId, made.action.id, { actorKey: sara.uuid, revision: made.action.revision, reviewMinutes: 5 }, at(1400 * MINUTE));
    expect(more.outcome).toBe('changed');
    expect(more.action.reviewExpiresAt.getTime()).toBe(at(1400 * MINUTE).getTime() + 120 * MINUTE);
  });

  it('ends with its goal or task: done, deleted, reached by a run, and the checks a goal set', async () => {
    const sara = await person('sara');
    const cardsOf = async (itemId: string) => (await prisma.botActionRequest.findMany({ where: { conversationKey: taskConversationKey(itemId) } })).map((row) => `${row.status}:${row.closedReason}`);

    const done = await goalOf(sara, { words: 'One' });
    await createRequest(sara.brickId, card(sara, done.id), NOW);
    await changeItem(sara.brickId, done.id, { userId: sara.uuid, action: 'done', result: 'Finished' }, NOW);
    expect(await cardsOf(done.id)).toEqual(['closed:cancelled']);

    const gone = await goalOf(sara, { words: 'Two' });
    const approved = await createRequest(sara.brickId, card(sara, gone.id), NOW);
    await decide(sara.brickId, approved.action.id, { actorKey: sara.uuid, revision: approved.action.revision, decision: 'approve' }, at(MINUTE));
    await changeItem(sara.brickId, gone.id, { userId: sara.uuid, action: 'delete' }, at(2 * MINUTE));
    expect(await cardsOf(gone.id)).toEqual(['closed:cancelled']);

    const parent = await goalOf(sara, { words: 'Three' });
    const check = await createItem(sara.brickId, { userId: sara.uuid, kind: 'watch', words: 'Embassy page', condition: 'It says approved', cadence: { type: 'every', minutes: 120 }, parentId: parent.id }, NOW);
    if (!check.ok) throw new Error(check.error);
    await createRequest(sara.brickId, card(sara, check.item.id), NOW);
    await changeItem(sara.brickId, parent.id, { userId: sara.uuid, action: 'done', result: 'Finished' }, at(MINUTE));
    expect(await cardsOf(check.item.id)).toEqual(['closed:cancelled']);

    // The outcome reached by a run ends the goal and its card
    const reachedGoal = await goalOf(sara, { words: 'Five' });
    await createRequest(sara.brickId, card(sara, reachedGoal.id), NOW);
    const [started] = (await claimDueRuns(at(61 * MINUTE))).filter((one) => one.itemId === reachedGoal.id);
    await finishRun(started.runId, { attempt: started.attempt, state: 'done', outcome: 'spoke', result: 'The visa was issued', reached: true }, at(62 * MINUTE));
    expect(await cardsOf(reachedGoal.id)).toEqual(['closed:cancelled']);

    // A goal that keeps going keeps its card
    const going = await goalOf(sara, { words: 'Four' });
    await createRequest(sara.brickId, card(sara, going.id), NOW);
    await changeItem(sara.brickId, going.id, { userId: sara.uuid, action: 'pause' }, at(MINUTE));
    expect(await cardsOf(going.id)).toEqual(['waiting:null']);
  });
});
