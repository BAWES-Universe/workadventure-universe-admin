/**
 * Brick reports (mock "Brick reports inbox", slices 1-3), against a real database: a Brick's note is cleaned, counted into a problem,
 * capped per Brick and day, taken back with the chat's key, and ranked in the super admin's inbox with counts only.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { NOTES_PER_BRICK_PER_DAY, TAKE_BACK_MS, recordReportNote, reportInbox, reportProblem, takeBackReportNote } from '@/lib/brick-reports';
import { POST as sendNote } from '@/app/api/bricks/reports/route';
import { POST as takeBack } from '@/app/api/me/brick-reports/take-back/route';
import { GET as inboxGet } from '@/app/api/admin/brick-reports/route';
import { GET as problemGet, PATCH as problemPatch } from '@/app/api/admin/brick-reports/[id]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
// Letters only: a run of digits in a title would be taken out as a long number
const tag = randomUUID().slice(0, 8).replace(/\d/g, (digit) => 'ghijklmnop'[Number(digit)]);
const SERVICE_TOKEN = `service-${tag}`;
const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let sara = '';
let omar = '';
let boss = '';
let saraBrick = '';
let omarBrick = '';
const envBefore = process.env.BOT_SERVICE_TOKEN;
const problems = new Set<string>();
const bricks = new Set<string>();
const keep = (problemId: string | null | undefined) => {
  if (problemId) problems.add(problemId);
};
const problemOf = async (id: unknown) => (await prisma.brickReportNote.findUniqueOrThrow({ where: { id: id as string }, select: { problemId: true } })).problemId!;

const note = (botId: string, title: string, over: Record<string, unknown> = {}) => ({
  botId,
  personKey: `person:${botId}`,
  kind: 'problem',
  area: 'pages',
  title,
  tried: 'Tried a link on each listing in a shortlist page.',
  stopped: 'Tapping a link does nothing in the chat preview.',
  effect: 'stopped',
  ...over,
});

async function send(body: Record<string, unknown>) {
  const response = await sendNote(request('/api/bricks/reports', { method: 'POST', body, token: SERVICE_TOKEN }));
  const json = (await response.json()) as Record<string, unknown>;
  if (json.sent === true) {
    const row = await prisma.brickReportNote.findUnique({ where: { id: json.id as string }, select: { problemId: true } });
    keep(row?.problemId);
  }
  return { status: response.status, json };
}

run('Brick reports', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Stay' })).id;
    omarBrick = (await createBrick({ ownerId: omar, name: 'Chef' })).id;
    bricks.add(saraBrick).add(omarBrick);
  });
  afterAll(async () => {
    if (envBefore === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = envBefore;
    await prisma.brickReportNote.deleteMany({ where: { OR: [{ problemId: { in: [...problems] } }, { botId: { in: [...bricks] } }] } });
    await prisma.brickReportProblem.deleteMany({ where: { id: { in: [...problems] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  it('only the bot server can send a note', async () => {
    const response = await sendNote(request('/api/bricks/reports', { method: 'POST', body: note(saraBrick, `Links ${tag} do not open`), token: 'wrong' }));
    expect(response.status).toBe(401);
  });

  it('keeps the note cleaned: no emails, links, @names, phone numbers or long numbers', async () => {
    const { json } = await send(
      note(saraBrick, `Files ${tag} links fail for sara@example.com`, {
        area: 'files',
        tried: 'Sent https://booking.example.com/x?id=1 and bawes.net/stay to @khalid, call +965 5555 1234',
        stopped: 'Order 1234567 failed',
        idea: 'Open links in a new tab',
      }),
    );
    expect(json.sent).toBe(true);
    const kept = json.note as Record<string, string>;
    expect(kept.title).toBe(`Files ${tag} links fail for`);
    expect(kept.tried).toBe('Sent and to, call');
    expect(kept.stopped).toBe('Order failed');
    expect(kept.idea).toBe('Open links in a new tab');
    const row = await prisma.brickReportNote.findUnique({ where: { id: json.id as string } });
    expect(row?.tried).toBe('Sent and to, call');
    // The person is only a one-way hash (marked only as signed in or guest), and the take-back key is never kept as it is
    expect(row?.personKey).toMatch(/^p:[0-9a-f]{32}$/);
    expect(row?.personKey).not.toContain(saraBrick);
    expect(row?.takeBackHash).not.toBe(json.takeBackKey);
  });

  it('notes that read alike join one problem; another kind, area or title starts its own', async () => {
    const first = await send(note(saraBrick, `Links inside pages ${tag} don't open`));
    const second = await send(note(omarBrick, `Links inside pages ${tag} do not open`, { personKey: `person:omar-${tag}` }));
    const otherArea = await send(note(omarBrick, `Links inside pages ${tag} don't open`, { area: 'chat' }));
    const otherTitle = await send(note(omarBrick, `Voice ${tag} cuts out after a minute`));
    expect(await problemOf(second.json.id)).toBe(await problemOf(first.json.id));
    expect(await problemOf(otherArea.json.id)).not.toBe(await problemOf(first.json.id));
    expect(await problemOf(otherTitle.json.id)).not.toBe(await problemOf(first.json.id));
    const detail = await reportProblem(await problemOf(first.json.id));
    expect(detail).toMatchObject({ bricks: 2, people: 2, times: 2, stoppedWork: true });
  });

  it('a Brick sends at most so many notes a day, whatever key it runs on', async () => {
    const day = new Date('2030-01-02T10:00:00Z');
    const brick = (await createBrick({ ownerId: sara, name: 'Busy' })).id;
    bricks.add(brick);
    for (let i = 0; i < NOTES_PER_BRICK_PER_DAY; i++) {
      const outcome = await recordReportNote({ botId: brick, kind: 'idea', area: 'other', title: `Idea ${tag} number ${i} about weekly email`, effect: 'idea' }, day);
      expect(outcome.sent).toBe(true);
      if (outcome.sent) keep(await problemOf(outcome.id));
    }
    expect(await recordReportNote({ botId: brick, kind: 'idea', area: 'other', title: `One ${tag} more`, effect: 'idea' }, day)).toEqual({ sent: false, reason: 'limit' });
    // The next day it can again
    const next = await recordReportNote({ botId: brick, kind: 'idea', area: 'other', title: `Idea ${tag} next day`, effect: 'idea' }, new Date('2030-01-03T10:00:00Z'));
    expect(next.sent).toBe(true);
    if (next.sent) keep(await problemOf(next.id));
  });

  it('refuses a note with no title left after cleaning, and one from a Brick that is not there, a room bot or a deleted Brick', async () => {
    expect((await send(note(saraBrick, 'https://example.com'))).json).toEqual({ sent: false, reason: 'empty' });
    expect((await send(note(randomUUID(), `Gone ${tag}`))).json).toEqual({ sent: false, reason: 'unknown_brick' });
    const universe = await prisma.universe.create({ data: { slug: `r-${tag}`, name: 'Report test', ownerId: sara } });
    try {
      const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
      const roomBot = await prisma.bot.create({ data: { roomId: room.id, name: 'Room bot', createdById: sara, behaviorConfig: {} } });
      expect((await send(note(roomBot.id, `Room ${tag} bot note`))).json).toEqual({ sent: false, reason: 'unknown_brick' });
    } finally {
      await prisma.universe.delete({ where: { id: universe.id } });
    }
    const gone = (await createBrick({ ownerId: sara, name: 'Gone' })).id;
    bricks.add(gone);
    await prisma.bot.update({ where: { id: gone }, data: { deletedAt: new Date(), goneAt: new Date(Date.now() + 86_400_000), enabledBeforeDelete: true, enabled: false } });
    expect((await send(note(gone, `Deleted ${tag} Brick note`))).json).toEqual({ sent: false, reason: 'unknown_brick' });
  });

  it('the chat takes a note back with its key within 24 hours; a wrong key or too late does nothing', async () => {
    const { json } = await send(note(saraBrick, `Take back ${tag} problem with maps`, { area: 'map' }));
    const id = json.id as string;
    const key = json.takeBackKey as string;
    // Nobody signed in (a guest's chat): the key is the proof
    mockUser.current = null;
    const wrong = await takeBack(request('/api/me/brick-reports/take-back', { method: 'POST', body: { id, key: `${key.slice(0, -2)}xx` } }));
    expect(await wrong.json()).toEqual({ takenBack: false, reason: 'not_found' });
    const created = (await prisma.brickReportNote.findUniqueOrThrow({ where: { id } })).createdAt;
    expect(await takeBackReportNote(id, key, new Date(created.getTime() + TAKE_BACK_MS + 1000))).toEqual({ takenBack: false, reason: 'too_late' });
    const right = await takeBack(request('/api/me/brick-reports/take-back', { method: 'POST', body: { id, key } }));
    expect(await right.json()).toEqual({ takenBack: true });
    expect(await takeBackReportNote(id, key)).toEqual({ takenBack: true });
    // Its words, context and person go at once; the row stays, empty, for the day's count. A problem it alone made goes with it
    const emptied = await prisma.brickReportNote.findUniqueOrThrow({ where: { id } });
    expect(emptied).toMatchObject({ title: '', tried: '', stopped: '', idea: '', context: null, personKey: null, problemId: null });
    expect(emptied.takenBackAt).not.toBeNull();
    expect(await prisma.brickReportProblem.count({ where: { title: { contains: `Take back ${tag}` } } })).toBe(0);
  });

  it('a problem a taken-back note started reads as the notes left, and never shows its title', async () => {
    const opener = await send(note(saraBrick, `Pages ${tag} share button private words`, { area: 'pages', kind: 'cant_do' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await send(note(omarBrick, `Pages ${tag} share button does nothing`, { area: 'pages', kind: 'cant_do', personKey: `person:omar-${tag}` }));
    const problemId = await problemOf(opener.json.id);
    expect(await problemOf(later.json.id)).toBe(problemId);
    expect(await takeBackReportNote(opener.json.id as string, opener.json.takeBackKey as string)).toEqual({ takenBack: true });
    const left = await prisma.brickReportProblem.findUniqueOrThrow({ where: { id: problemId } });
    expect(left.title).toBe(`Pages ${tag} share button does nothing`);
    expect(left.lastSeenAt.getTime()).toBe((await prisma.brickReportNote.findUniqueOrThrow({ where: { id: later.json.id as string } })).createdAt.getTime());
    expect(await reportProblem(problemId)).toMatchObject({ title: `Pages ${tag} share button does nothing`, times: 1, bricks: 1 });
  });

  it('one person cannot push a problem to High alone: Bricks of one owner count once, guests count 1 each and 2 at most', async () => {
    const own: string[] = [];
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']) own.push((await createBrick({ ownerId: sara, name })).id);
    own.forEach((id) => bricks.add(id));
    for (const [i, id] of own.entries()) await send(note(id, `Voice ${tag} drops when the call starts`, { area: 'voice', personKey: `guest:g${i}-${tag}` }));
    const problemId = await problemOf((await prisma.brickReportNote.findFirstOrThrow({ where: { botId: own[0] }, select: { id: true } })).id);
    const detail = await reportProblem(problemId);
    expect(detail).toMatchObject({ bricks: 9, people: 9, times: 9, level: 'low' });
    expect(detail?.reasons).toEqual([
      { label: 'Stopped the work', points: 5 },
      { label: '9 Bricks', points: 3 },
      { label: '9 people', points: 2 },
    ]);
  });

  it('the inbox is for super admins, ranks by priority, and never says who sent a note', async () => {
    const big = await send(note(saraBrick, `Apps ${tag} sign out and tools vanish`, { area: 'apps' }));
    await send(note(omarBrick, `Apps ${tag} sign out and tools vanish quietly`, { area: 'apps', personKey: `person:omar-${tag}` }));
    const small = await send(note(saraBrick, `Weekly ${tag} summary by email`, { kind: 'idea', area: 'apps', effect: 'idea', tried: '', stopped: '', idea: 'Send it Fridays' }));
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    expect((await inboxGet(request('/api/admin/brick-reports'))).status).toBe(403);
    mockUser.current = { id: boss, email: 'boss@example.test' };
    const response = await inboxGet(request('/api/admin/brick-reports?state=new'));
    expect(response.status).toBe(200);
    const body = await response.json();
    const text = JSON.stringify(body);
    for (const secret of [saraBrick, omarBrick, sara, omar, 'personKey', 'botId', 'takeBack']) expect(text).not.toContain(secret);
    const bigProblem = await problemOf(big.json.id);
    const smallProblem = await problemOf(small.json.id);
    const order = (body.problems as Array<{ id: string }>).map((row) => row.id);
    expect(order.indexOf(bigProblem)).toBeLessThan(order.indexOf(smallProblem));

    const detail = await problemGet(request(`/api/admin/brick-reports/${bigProblem}`), params({ id: bigProblem }));
    const shown = await detail.json();
    expect(shown).toMatchObject({ bricks: 2, people: 2, times: 2, level: 'medium' });
    expect(shown.reasons).toEqual([
      { label: 'Stopped the work', points: 5 },
      { label: '2 Bricks', points: 6 },
      { label: '2 people', points: 4 },
    ]);
    expect(shown.sample).toHaveLength(2);
    for (const secret of [saraBrick, omarBrick, 'personKey', 'botId']) expect(JSON.stringify(shown)).not.toContain(secret);
  });

  it('moves a problem between tabs, and a note on a fixed problem brings it back to New', async () => {
    const first = await send(note(saraBrick, `Memory ${tag} forgets the city`, { area: 'memory' }));
    const problemId = await problemOf(first.json.id);
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    expect((await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }))).status).toBe(403);
    mockUser.current = { id: boss, email: 'boss@example.test' };
    const moved = await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    expect(moved.status).toBe(200);
    expect((await reportInbox('fixed')).problems.some((row) => row.id === problemId)).toBe(true);
    await send(note(omarBrick, `Memory ${tag} forgets the city again`, { area: 'memory' }));
    const back = await reportProblem(problemId);
    expect(back).toMatchObject({ state: 'new', cameBack: true });
    expect(back?.reasons).toContainEqual({ label: 'Came back after a fix', points: 6 });
    // Taking back the note that brought it back puts it back to Fixed; with a later note still there, it stays open
    const fixedAgain = await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    expect(fixedAgain.status).toBe(200);
    const reopen = await send(note(saraBrick, `Memory ${tag} forgets the city once more`, { area: 'memory' }));
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
    expect(await takeBackReportNote(reopen.json.id as string, reopen.json.takeBackKey as string)).toEqual({ takenBack: true });
    expect(await reportProblem(problemId)).toMatchObject({ state: 'fixed', cameBack: false });
    expect((await reportInbox('new')).problems.some((row) => row.id === problemId)).toBe(false);
    await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    const opener = await send(note(saraBrick, `Memory ${tag} forgets the city yet again`, { area: 'memory' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(note(omarBrick, `Memory ${tag} forgets the city again today`, { area: 'memory', personKey: `person:omar-${tag}` }));
    await takeBackReportNote(opener.json.id as string, opener.json.takeBackKey as string);
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
    // Moved by hand after it came back: taking the note back leaves the person's call as it is
    await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    const third = await send(note(saraBrick, `Memory ${tag} forgets the city each time`, { area: 'memory' }));
    await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'working' } }), params({ id: problemId }));
    await takeBackReportNote(third.json.id as string, third.json.takeBackKey as string);
    expect(await reportProblem(problemId)).toMatchObject({ state: 'working' });

    const missing = await problemPatch(request(`/api/admin/brick-reports/${randomUUID()}`, { method: 'PATCH', body: { state: 'new' } }), params({ id: randomUUID() }));
    expect(missing.status).toBe(404);
  });
});
