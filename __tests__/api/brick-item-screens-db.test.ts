/**
 * The screens for goals and tasks (game #2002) against a real database: the group on a Brick's page, the one list across all Bricks,
 * the owner's own taps, and "Everything Brick did". Only the owner sees any of it; a Brick that waits deleted is not listed; every run
 * is on record, quiet ones and failed ones too. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-item-screens-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn(async () => undefined) }));

import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { deleteBrick, undoBrickDelete } from '@/lib/brick-delete';
import { makeBrick } from '@/lib/brick-make';
import { claimDueRuns, createItem, finishRun, type NewItemInput } from '@/lib/brick-items';
import { GET as listAll } from '@/app/api/bricks/items/route';
import { GET as listOne } from '@/app/api/bricks/[id]/items/route';
import { GET as readOne, PATCH as tap } from '@/app/api/bricks/[id]/items/[itemId]/route';
import { GET as did } from '@/app/api/bricks/[id]/did/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const people: string[] = [];
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-12T06:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const signedInAs = (id: string | null) => (getSessionUser as jest.Mock).mockResolvedValue(id ? { id } : null);

async function person(name: string) {
  const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
  people.push(user.id);
  await prisma.userPreference.create({ data: { userId: user.id, key: 'timeZone', value: 'Asia/Kuwait' } });
  const { brick } = await ensureDefaultBrick(user.id);
  return { id: user.id, uuid: user.uuid, brickId: brick!.id };
}

async function set(who: { uuid: string; brickId: string }, over: Partial<NewItemInput> = {}) {
  const answer = await createItem(who.brickId, { userId: who.uuid, kind: 'reminder', words: 'Call the dentist', cadence: { type: 'once', at: at(HOUR).toISOString() }, ...over }, NOW);
  if (!answer.ok) throw new Error(answer.error);
  return answer.item;
}

const req = (path: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost${path}`, { method: init?.method ?? 'GET', headers: { 'content-type': 'application/json' }, body: init?.body ? JSON.stringify(init.body) : undefined });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const itemParams = (id: string, itemId: string) => ({ params: Promise.resolve({ id, itemId }) });

run('goals and tasks screens, in a real database', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });
  afterEach(() => signedInAs(null));

  it('lists the owner’s goals and tasks by group, on one Brick and across all Bricks, with a goal’s own checks nested under it', async () => {
    const sara = await person('sara');
    const garden = await makeBrick(sara.id, { name: 'Garden Brick' });
    const reminder = await set(sara);
    const briefing = await set(sara, { kind: 'schedule', words: 'Morning', cadence: { type: 'daily', time: '07:30', days: [0, 1, 2, 3, 4] } });
    const goal = await set(sara, { kind: 'goal', words: 'Get my visa', outcome: 'Visa issued', cadence: { type: 'every', minutes: 60 } });
    const check = await createItem(sara.brickId, { userId: sara.uuid, kind: 'watch', words: 'Embassy page', condition: 'It says approved', cadence: { type: 'every', minutes: 120 }, parentId: goal.id }, NOW);
    const watering = await set({ uuid: sara.uuid, brickId: garden.id }, { words: 'Water the plants' });
    const finished = await set(sara, { words: 'Old thing' });
    await prisma.brickItem.update({ where: { id: finished.id }, data: { state: 'done', nextDueAt: null, doneAt: NOW } });

    signedInAs(sara.id);
    const one = await (await listOne(req(`/api/bricks/${sara.brickId}/items`), idParams(sara.brickId))).json();
    const byId = Object.fromEntries(one.items.map((item: { id: string }) => [item.id, item]));
    expect(Object.keys(byId).sort()).toEqual([reminder.id, briefing.id, goal.id, finished.id].sort());
    expect(byId[reminder.id]).toMatchObject({ group: 'scheduled', brickName: 'Brick', checks: [] });
    expect(byId[goal.id]).toMatchObject({ group: 'progress' });
    expect(byId[goal.id].checks.map((one: { id: string }) => one.id)).toEqual([check.ok ? check.item.id : '']);
    expect(byId[finished.id]).toMatchObject({ group: 'done' });

    const all = await (await listAll(req('/api/bricks/items'))).json();
    expect(all.items.map((item: { id: string }) => item.id)).toContain(watering.id);
    expect(all.items.find((item: { id: string }) => item.id === watering.id)).toMatchObject({ brickName: 'Garden Brick' });
    // A check is never a row of its own
    expect(all.items.map((item: { parentId: string | null }) => item.parentId)).toEqual(all.items.map(() => null));
  });

  it('shows nothing to anyone but the owner: not another person, not a signed-out visitor, not a Brick that is not theirs', async () => {
    const hadi = await person('hadi');
    const lina = await person('lina');
    const item = await set(hadi);
    signedInAs(lina.id);
    expect((await listOne(req(`/api/bricks/${hadi.brickId}/items`), idParams(hadi.brickId))).status).toBe(404);
    expect((await did(req(`/api/bricks/${hadi.brickId}/did`), idParams(hadi.brickId))).status).toBe(404);
    expect((await tap(req(`/api/bricks/${hadi.brickId}/items/${item.id}`, { method: 'PATCH', body: { action: 'pause' } }), itemParams(hadi.brickId, item.id))).status).toBe(404);
    expect((await (await listAll(req('/api/bricks/items'))).json()).items).toEqual([]);
    expect((await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('on');
    signedInAs(null);
    expect((await listAll(req('/api/bricks/items'))).status).toBe(401);
  });

  it('leaves out the goals and tasks of a Brick that waits deleted, and gives them back, still paused, with Undo', async () => {
    const omar = await person('omar');
    const second = await makeBrick(omar.id, { name: 'Studio Brick' });
    const item = await set({ uuid: omar.uuid, brickId: second.id }, { words: 'Send the invoice' });
    signedInAs(omar.id);
    expect((await (await listAll(req('/api/bricks/items'))).json()).items.map((one: { id: string }) => one.id)).toContain(item.id);
    await deleteBrick(second.id, omar.id, NOW);
    expect((await (await listAll(req('/api/bricks/items'))).json()).items.map((one: { id: string }) => one.id)).not.toContain(item.id);
    await undoBrickDelete(second.id, omar.id, at(HOUR));
    const back = (await (await listAll(req('/api/bricks/items'))).json()).items.find((one: { id: string }) => one.id === item.id);
    expect(back).toMatchObject({ state: 'paused', pausedBy: 'brick_deleted' });
  });

  it('takes the owner’s taps: pause, resume, snooze, mark done, reopen and delete, and refuses a change here and what does not fit', async () => {
    const maya = await person('maya');
    const item = await set(maya, { kind: 'schedule', words: 'Morning', cadence: { type: 'every', minutes: 60 } });
    signedInAs(maya.id);
    const press = async (body: unknown, id = item.id) => tap(req(`/api/bricks/${maya.brickId}/items/${id}`, { method: 'PATCH', body }), itemParams(maya.brickId, id));
    expect(await (await press({ action: 'pause' })).json()).toMatchObject({ item: { state: 'paused', pausedBy: 'owner' } });
    expect(await (await press({ action: 'snooze' })).json()).toMatchObject({ code: 'wrong_state' });
    expect(await (await press({ action: 'resume' })).json()).toMatchObject({ item: { state: 'on' } });
    expect(await (await press({ action: 'snooze' })).json()).toMatchObject({ item: { state: 'on', cadence: { type: 'every', minutes: 60 } } });
    expect(await (await press({ action: 'done', result: 'Not needed any more' })).json()).toMatchObject({ item: { state: 'done', result: 'Not needed any more' } });
    expect(await (await press({ action: 'reopen' })).json()).toMatchObject({ item: { state: 'on', result: null } });
    // A change is made in the Brick's own chat, in the person's own words: there is no form here
    expect((await press({ action: 'change', change: { words: 'Something else' } })).status).toBe(400);
    expect((await press({ action: 'fly' })).status).toBe(400);
    expect((await press({ action: 'pause' }, 'no-such-item')).status).toBe(404);
    expect(await (await press({ action: 'delete' })).json()).toMatchObject({ item: { state: 'deleted' } });
    expect((await (await listOne(req(`/api/bricks/${maya.brickId}/items`), idParams(maya.brickId))).json()).items).toEqual([]);
  });

  it('lists everything Brick did, newest first, failed runs and quiet checks included, a page at a time', async () => {
    const eli = await person('eli');
    const watch = await set(eli, { kind: 'watch', words: 'Flight', condition: 'It drops', cadence: { type: 'every', minutes: 60 } });
    const outcomes: { state: 'done' | 'failed'; outcome?: 'quiet' | 'spoke'; result?: string; error?: string }[] = [
      { state: 'done', outcome: 'quiet' },
      { state: 'failed', error: 'The site did not answer' },
      { state: 'done', outcome: 'quiet', result: 'Still 120' },
    ];
    for (let i = 0; i < outcomes.length; i++) {
      const [one] = (await claimDueRuns(at((i + 1) * HOUR + 60_000))).filter((run) => run.itemId === watch.id);
      await finishRun(one.runId, { ...outcomes[i], attempt: one.attempt }, at((i + 1) * HOUR + 120_000));
    }
    signedInAs(eli.id);
    const page = await (await did(req(`/api/bricks/${eli.brickId}/did`), idParams(eli.brickId))).json();
    expect(page.runs.map((one: { state: string; outcome: string | null }) => [one.state, one.outcome])).toEqual([
      ['done', 'quiet'],
      ['failed', null],
      ['done', 'quiet'],
    ]);
    expect(page.runs[0]).toMatchObject({ words: 'Flight', kind: 'watch', result: 'Still 120', late: false });
    expect(page.runs[1]).toMatchObject({ error: 'The site did not answer' });
    expect(page.next).toBeNull();
    // Rows only: nothing that was said anywhere
    expect(Object.keys(page.runs[0]).sort()).toEqual(['brickId', 'dueAt', 'error', 'finishedAt', 'fresh', 'itemId', 'kind', 'late', 'outcome', 'result', 'runId', 'state', 'words']);
    expect((await did(req(`/api/bricks/${eli.brickId}/did?before=soon`), idParams(eli.brickId))).status).toBe(400);
  });

  it('reads one item for its owner only: another person, a signed-out visitor and an item that is not there all get nothing', async () => {
    const lena = await person('lena');
    const other = await person('lenaother');
    const item = await set(lena, { words: 'Water the plants' });
    const read = (brickId: string, itemId: string) => readOne(req(`/api/bricks/${brickId}/items/${itemId}`), itemParams(brickId, itemId));
    signedInAs(lena.id);
    expect(await (await read(lena.brickId, item.id)).json()).toMatchObject({ item: { id: item.id, words: 'Water the plants', state: 'on' } });
    expect((await read(lena.brickId, 'no-such-item')).status).toBe(404);
    signedInAs(other.id);
    expect((await read(lena.brickId, item.id)).status).toBe(404);
    signedInAs(null);
    expect((await read(lena.brickId, item.id)).status).toBe(401);
  });

  it('pages through everything Brick did without skipping runs claimed in the same moment', async () => {
    const nora = await person('nora');
    const watch = await set(nora, { kind: 'watch', words: 'Flight', condition: 'It drops', cadence: { type: 'every', minutes: 60 } });
    // 120 runs claimed at one instant: a page is 50, so a page boundary falls inside them
    const claimedAt = at(2 * HOUR);
    await prisma.brickItemRun.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ itemId: watch.id, dueAt: at(HOUR + i * 60_000), revision: 1, claimedAt, leaseUntil: at(3 * HOUR), state: 'done', outcome: 'quiet', finishedAt: claimedAt })),
    });
    signedInAs(nora.id);
    const seen: string[] = [];
    let before = '';
    for (let pages = 0; pages < 10; pages++) {
      const page = await (await did(req(`/api/bricks/${nora.brickId}/did${before}`), idParams(nora.brickId))).json();
      seen.push(...page.runs.map((one: { runId: string }) => one.runId));
      if (!page.next) break;
      before = `?before=${encodeURIComponent(page.next)}`;
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });
});
