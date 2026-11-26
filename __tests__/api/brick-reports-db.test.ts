/**
 * Brick reports (mock "Brick reports inbox", slices 1-3), against a real database: a Brick's product-only note is counted into a problem,
 * capped per Brick and day, answered with the same receipt when sent again, given the person's own words only when they send them, read
 * back and taken back with the chat's key, and ranked in the super admin's inbox with counts only.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; email?: string | null } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import {
  NOTES_PER_BRICK_PER_DAY,
  RECEIPT_WAIT_MS,
  TAKE_BACK_MS,
  confirmReportReceipts,
  forgetReportWordsOf,
  recordReportNote,
  reportInbox,
  reportProblem,
  setReportState,
  takeBackReportNote,
  withdrawUndelivered,
} from '@/lib/brick-reports';
import { POST as sendNote } from '@/app/api/bricks/reports/route';
import { POST as takeBack } from '@/app/api/me/brick-reports/take-back/route';
import { POST as addWords } from '@/app/api/me/brick-reports/words/route';
import { POST as readStatus } from '@/app/api/me/brick-reports/status/route';
import { POST as confirmDelivered } from '@/app/api/bricks/reports/delivered/route';
import { GET as inboxGet } from '@/app/api/admin/brick-reports/route';
import { GET as problemGet, PATCH as problemPatch } from '@/app/api/admin/brick-reports/[id]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
// Letters only, so it fits in a tool name (what ran): each test's notes have their own, so they never join another run's problems
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
const keyBefore = process.env.ENCRYPTION_KEY;
const problems = new Set<string>();
const bricks = new Set<string>();
const keep = (problemId: string | null | undefined) => {
  if (problemId) problems.add(problemId);
};
const problemOf = async (id: unknown) => (await prisma.brickReportNote.findUniqueOrThrow({ where: { id: id as string }, select: { problemId: true } })).problemId!;

const ref = () => randomBytes(32).toString('hex');
/** A product-only note: `step` names what ran (a tool of this run only), so each test counts into problems of its own. */
const note = (botId: string, step: string, over: Record<string, unknown> = {}) => ({
  botId,
  personKey: `person:${botId}`,
  ref: ref(),
  kind: 'problem',
  area: 'pages',
  operation: `${step}_${tag}`,
  failure: 'failed',
  retried: false,
  effect: 'stopped',
  ...over,
});
const idea = (botId: string, step: string) => ({ botId, ref: ref(), kind: 'idea' as const, area: 'other' as const, operation: `${step}_${tag}`, failure: 'idea' as const, retried: false, effect: 'idea' as const });
/** New Bricks for Sara and Omar: a Brick sends at most so many notes a day, so a long test starts with Bricks that sent none. */
async function freshPair(): Promise<[string, string]> {
  const pair: [string, string] = [(await createBrick({ ownerId: sara, name: 'Stay' })).id, (await createBrick({ ownerId: omar, name: 'Chef' })).id];
  pair.forEach((id) => bricks.add(id));
  return pair;
}
const me = (path: string, body: unknown) => request(path, { method: 'POST', body });

let lostReceipt = false;
async function send(body: Record<string, unknown>) {
  const response = await sendNote(request('/api/bricks/reports', { method: 'POST', body, token: SERVICE_TOKEN }));
  const json = (await response.json()) as Record<string, unknown>;
  if (json.sent === true) {
    const row = await prisma.brickReportNote.findUnique({ where: { id: json.id as string }, select: { problemId: true } });
    keep(row?.problemId);
  }
  // The chat got its receipt (the bot server says so once its message went out), unless a test is about a lost one
  if (json.sent === true && !lostReceipt) await confirmReportReceipts(body.botId as string, [json.id as string]);
  return { status: response.status, json };
}

run('Brick reports', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    // The take-back key is kept sealed, to hand the same receipt back when a note is sent again
    process.env.ENCRYPTION_KEY = keyBefore || 'a'.repeat(64);
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
    if (keyBefore === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = keyBefore;
    await prisma.brickReportNote.deleteMany({ where: { OR: [{ problemId: { in: [...problems] } }, { botId: { in: [...bricks] } }] } });
    await prisma.brickReportProblem.deleteMany({ where: { id: { in: [...problems] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  it('only the bot server can send a note, and only product-only fields', async () => {
    const response = await sendNote(request('/api/bricks/reports', { method: 'POST', body: note(saraBrick, 'open_link'), token: 'wrong' }));
    expect(response.status).toBe(401);
    // No free text from the chat: a title, or words as "what ran", are refused
    expect((await send({ ...note(saraBrick, 'open_link'), title: 'Cannot open Blue Plover binder' })).status).toBe(400);
    expect((await send({ ...note(saraBrick, 'open_link'), operation: 'Cannot open Blue Plover binder' })).status).toBe(400);
    expect((await send({ ...note(saraBrick, 'open_link'), ref: 'not-a-ref' })).status).toBe(400);
    // Context holds no words either: only own key or not and the game's version
    expect((await send({ ...note(saraBrick, 'open_link'), context: { model: 'Blue Plover binder' } })).status).toBe(400);
    expect((await send({ ...note(saraBrick, 'open_link'), context: { tools: ['Blue Plover binder'] } })).status).toBe(400);
    expect((await send({ ...note(saraBrick, 'open_link'), context: { gameVersion: 'Blue Plover binder' } })).status).toBe(400);
  });

  it('keeps a note with no words: its title is built from fixed words, and draft words only come back cleaned, not kept', async () => {
    const { json } = await send(
      note(saraBrick, 'open_link', {
        area: 'files',
        failure: 'timed_out',
        retried: true,
        draftWords: 'Sent https://booking.example.com/x?id=1 and bawes.net/stay to @khalid, call +965 5555 1234. Order 1234567 failed',
      }),
    );
    expect(json.sent).toBe(true);
    expect(json.note).toEqual({ kind: 'problem', area: 'files', title: 'Timed out: Files', operation: `open_link_${tag}`, failure: 'timed_out', retried: true, effect: 'stopped' });
    expect(json.wordsPreview).toBe('Sent and to, call. Order failed');
    const row = await prisma.brickReportNote.findUniqueOrThrow({ where: { id: json.id as string } });
    expect(row.words).toBe('');
    expect(JSON.stringify(row)).not.toContain('Order');
    // The person is only a one-way hash (marked only as signed in or guest), and the take-back key is never kept as it is
    expect(row.personKey).toMatch(/^p:[0-9a-f]{32}$/);
    expect(row.personKey).not.toContain(saraBrick);
    expect(row.takeBackHash).not.toBe(json.takeBackKey);
    expect(row.takeBackSealed).not.toContain(json.takeBackKey as string);
  });

  it('an App is named only when it is in the catalog; any other App is just "an App"', async () => {
    const [saraBrick] = await freshPair();
    const key = `rep-${tag}`;
    await prisma.appCatalogEntry.create({ data: { key, name: 'Report Mail', blurb: 'Test', serverUrl: 'https://example.test/mcp' } });
    try {
      const known = await send(note(saraBrick, 'x', { area: 'apps', operation: `app:${key}`, failure: 'signed_out' }));
      expect(known.json.note).toMatchObject({ operation: `app:${key}`, title: 'Signed out: Report Mail App' });
      const unknown = await send(note(saraBrick, 'x', { area: 'apps', operation: `app:private-${tag}`, failure: 'signed_out' }));
      expect(unknown.json.note).toMatchObject({ operation: 'app', title: 'Signed out: an App' });
      // Known only by its connection: named by the catalog App it came from, never by the name the person gave it
      const fromCatalog = await prisma.appConnection.create({ data: { ownerId: sara, name: 'Blue Plover binder', serverUrl: 'https://example.test/mcp', catalogKey: key } });
      const own = await prisma.appConnection.create({ data: { ownerId: sara, name: 'Blue Plover binder', serverUrl: 'https://example.test/own' } });
      const viaCatalog = await send(note(saraBrick, 'x', { area: 'apps', operation: 'app', appConnectionId: fromCatalog.id, failure: 'failed' }));
      expect(viaCatalog.json.note).toMatchObject({ operation: `app:${key}`, title: 'Failed: Report Mail App' });
      const viaOwn = await send(note(saraBrick, 'x', { area: 'apps', operation: 'app', appConnectionId: own.id, failure: 'failed' }));
      expect(viaOwn.json.note).toMatchObject({ operation: 'app', title: 'Failed: an App' });
      for (const sent of [viaCatalog, viaOwn]) {
        const row = await prisma.brickReportNote.findUniqueOrThrow({ where: { id: sent.json.id as string } });
        expect(JSON.stringify(row)).not.toContain('Blue Plover');
        expect(JSON.stringify(row)).not.toContain(own.id);
      }
      await prisma.appConnection.deleteMany({ where: { id: { in: [fromCatalog.id, own.id] } } });
    } finally {
      await prisma.appCatalogEntry.delete({ where: { key } });
    }
  });

  it('an App with the longest catalog key (60) is kept with its name, by key or by connection (Sentry)', async () => {
    const [saraBrick] = await freshPair();
    const key = `long-${tag}-`.padEnd(60, 'k');
    expect(key).toHaveLength(60);
    await prisma.appCatalogEntry.create({ data: { key, name: 'Long Mail', blurb: 'Test', serverUrl: 'https://example.test/mcp' } });
    const connection = await prisma.appConnection.create({ data: { ownerId: sara, name: 'Mine', serverUrl: 'https://example.test/mcp', catalogKey: key } });
    try {
      const byKey = await send(note(saraBrick, 'long', { area: 'apps', operation: `app:${key}`, failure: 'failed' }));
      expect(byKey.status).toBe(200);
      expect(byKey.json.note).toMatchObject({ operation: `app:${key}`, title: 'Failed: Long Mail App' });
      const byConnection = await send(note(saraBrick, 'long_connection', { area: 'apps', operation: 'app', appConnectionId: connection.id, failure: 'timed_out' }));
      expect(byConnection.status).toBe(200);
      expect(byConnection.json.note).toMatchObject({ operation: `app:${key}` });
    } finally {
      await prisma.appConnection.deleteMany({ where: { id: connection.id } });
      await prisma.appCatalogEntry.delete({ where: { key } });
    }
  });

  it('sent again with the same reference, it answers the same receipt and keeps nothing new', async () => {
    const body = note(saraBrick, 'resend');
    const first = await send(body);
    const again = await send(body);
    expect(again.json).toMatchObject({ sent: true, id: first.json.id, takeBackKey: first.json.takeBackKey, note: first.json.note, again: true });
    expect(await prisma.brickReportNote.count({ where: { botId: saraBrick, ref: body.ref } })).toBe(1);
    expect((await reportProblem(await problemOf(first.json.id)))?.times).toBe(1);
    // Taken back, it still answers the same receipt, marked taken back, and starts nothing new
    expect(await takeBackReportNote(first.json.id as string, first.json.takeBackKey as string)).toEqual({ takenBack: true });
    const late = await send(body);
    expect(late.json).toMatchObject({ sent: true, id: first.json.id, again: true, takenBack: true });
    expect(await prisma.brickReportNote.count({ where: { botId: saraBrick, ref: body.ref } })).toBe(1);
    // Many at once with one reference still keep one note
    const twin = note(omarBrick, 'resend_twin');
    const all = await Promise.all([send(twin), send(twin), send(twin)]);
    expect(new Set(all.map((one) => one.json.id)).size).toBe(1);
    expect(await prisma.brickReportNote.count({ where: { botId: omarBrick, ref: twin.ref } })).toBe(1);
  });

  it('notes alike (kind, area, what ran, how it failed) join one problem; any other starts its own', async () => {
    const first = await send(note(saraBrick, 'links'));
    const second = await send(note(omarBrick, 'links', { personKey: `person:omar-${tag}`, retried: true }));
    const otherArea = await send(note(omarBrick, 'links', { area: 'chat' }));
    const otherFailure = await send(note(omarBrick, 'links', { failure: 'no_result' }));
    const otherStep = await send(note(omarBrick, 'voice'));
    expect(await problemOf(second.json.id)).toBe(await problemOf(first.json.id));
    for (const other of [otherArea, otherFailure, otherStep]) expect(await problemOf(other.json.id)).not.toBe(await problemOf(first.json.id));
    const detail = await reportProblem(await problemOf(first.json.id));
    expect(detail).toMatchObject({ bricks: 2, people: 2, times: 2, stoppedWork: true, retried: 1, withWords: 0, sample: [] });
  });

  it('the person adds their own words only by sending them, cleaned the same way the chat showed them', async () => {
    const { json } = await send(note(saraBrick, 'words', { draftWords: 'The share button at www.example.com does nothing' }));
    const id = json.id as string;
    const key = json.takeBackKey as string;
    expect(json.wordsPreview).toBe('The share button at does nothing');
    mockUser.current = null;
    const wrong = await addWords(me('/api/me/brick-reports/words', { id, key: `${key.slice(0, -2)}xx`, words: 'Hello there' }));
    expect(await wrong.json()).toEqual({ added: false, reason: 'not_found' });
    expect(await (await addWords(me('/api/me/brick-reports/words', { id, key, words: 'https://example.com' }))).json()).toEqual({ added: false, reason: 'empty' });
    const added = await addWords(me('/api/me/brick-reports/words', { id, key, words: 'The share button at www.example.com does nothing' }));
    expect(await added.json()).toEqual({ added: true, words: json.wordsPreview });
    expect((await prisma.brickReportNote.findUniqueOrThrow({ where: { id } })).words).toBe(json.wordsPreview);
    const detail = await reportProblem(await problemOf(id));
    expect(detail).toMatchObject({ withWords: 1, sample: [json.wordsPreview] });
    const created = (await prisma.brickReportNote.findUniqueOrThrow({ where: { id } })).createdAt;
    const { addReportWords } = await import('@/lib/brick-reports');
    expect(await addReportWords(id, key, 'Later words', new Date(created.getTime() + TAKE_BACK_MS + 1000))).toEqual({ added: false, reason: 'too_late' });
  });

  it('the chat reads what became of a note with its key, on any device', async () => {
    const { json } = await send(note(saraBrick, 'status'));
    const id = json.id as string;
    const key = json.takeBackKey as string;
    mockUser.current = null;
    expect(await (await readStatus(me('/api/me/brick-reports/status', { id, key: `${key.slice(0, -2)}xx` }))).json()).toEqual({ state: 'not_found' });
    expect(await (await readStatus(me('/api/me/brick-reports/status', { id, key }))).json()).toEqual({ state: 'live', words: '', canTakeBack: true });
    await takeBackReportNote(id, key);
    expect(await (await readStatus(me('/api/me/brick-reports/status', { id, key }))).json()).toEqual({ state: 'taken_back', words: '', canTakeBack: false });
    expect(await (await addWords(me('/api/me/brick-reports/words', { id, key, words: 'Too late now' }))).json()).toEqual({ added: false, reason: 'taken_back' });
  });

  it('a note whose receipt never reached its chat is withdrawn after a fixed time, like Take it back; a confirmed one stays', async () => {
    const [brick, other] = await freshPair();
    lostReceipt = true;
    try {
      const lost = await send(note(brick, 'lost_receipt', { draftWords: 'Never shown' }));
      const kept = await send(note(brick, 'lost_receipt_kept'));
      const opened = await send(note(brick, 'lost_receipt_opened'));
      // Only the bot server, with its token, and only for its own Brick's notes
      const wrongToken = await confirmDelivered(request('/api/bricks/reports/delivered', { method: 'POST', body: { botId: brick, ids: [kept.json.id] }, token: 'wrong' }));
      expect(wrongToken.status).toBe(401);
      const confirm = await confirmDelivered(request('/api/bricks/reports/delivered', { method: 'POST', body: { botId: other, ids: [kept.json.id] }, token: SERVICE_TOKEN }));
      expect(await confirm.json()).toEqual({ confirmed: 0 });
      const mine = await confirmDelivered(request('/api/bricks/reports/delivered', { method: 'POST', body: { botId: brick, ids: [kept.json.id] }, token: SERVICE_TOKEN }));
      expect(await mine.json()).toEqual({ confirmed: 1 });
      // A chat that reads its note proves it got the receipt
      mockUser.current = null;
      await readStatus(me('/api/me/brick-reports/status', { id: opened.json.id, key: opened.json.takeBackKey }));
      const lostProblem = await problemOf(lost.json.id);
      // Not yet: it waits a while for the bot server's word
      const created = (await prisma.brickReportNote.findUniqueOrThrow({ where: { id: lost.json.id as string } })).createdAt;
      expect(await withdrawUndelivered(new Date(created.getTime() + RECEIPT_WAIT_MS - 1000))).toBe(0);
      // Then it is withdrawn, emptied like Take it back, and its problem (only it) goes; the confirmed and the opened ones stay
      await withdrawUndelivered(new Date(created.getTime() + RECEIPT_WAIT_MS + 1000));
      const gone = await prisma.brickReportNote.findUniqueOrThrow({ where: { id: lost.json.id as string } });
      expect(gone).toMatchObject({ words: '', context: null, personKey: null, problemId: null });
      expect(gone.takenBackAt).not.toBeNull();
      expect(await prisma.brickReportProblem.count({ where: { id: lostProblem } })).toBe(0);
      for (const live of [kept, opened]) expect((await prisma.brickReportNote.findUniqueOrThrow({ where: { id: live.json.id as string } })).takenBackAt).toBeNull();
      // Sent again with the same reference, it answers "taken back" and keeps nothing new
      expect((await send({ ...note(brick, 'lost_receipt'), ref: (await prisma.brickReportNote.findUniqueOrThrow({ where: { id: lost.json.id as string } })).ref })).json).toMatchObject({ id: lost.json.id, takenBack: true });
    } finally {
      lostReceipt = false;
    }
  });

  it('a receipt confirmed after the lost notes were listed keeps its note (Sentry)', async () => {
    const [brick] = await freshPair();
    lostReceipt = true;
    try {
      const late = await send(note(brick, 'late_receipt'));
      const created = (await prisma.brickReportNote.findUniqueOrThrow({ where: { id: late.json.id as string } })).createdAt;
      // The bot server's word lands just after the withdrawal listed the note as lost, before it empties it
      const list = prisma.brickReportNote.findMany.bind(prisma.brickReportNote);
      const listed = jest.spyOn(prisma.brickReportNote, 'findMany').mockImplementationOnce((async (args: Parameters<typeof list>[0]) => {
        const rows = await list(args);
        await confirmReportReceipts(brick, [late.json.id as string]);
        return rows;
      }) as never);
      try {
        expect(await withdrawUndelivered(new Date(created.getTime() + RECEIPT_WAIT_MS + 1000))).toBe(0);
      } finally {
        listed.mockRestore();
      }
      const row = await prisma.brickReportNote.findUniqueOrThrow({ where: { id: late.json.id as string } });
      expect(row.takenBackAt).toBeNull();
      expect(row.deliveredAt).not.toBeNull();
      expect(row.problemId).not.toBeNull();
    } finally {
      lostReceipt = false;
    }
  });

  it('deleting a person’s account empties the words they sent; their notes stay counted', async () => {
    const [brick] = await freshPair();
    const uuid = `leaver-${tag}`;
    const { json } = await send(note(brick, 'leaver', { personKey: `person:${uuid}` }));
    mockUser.current = null;
    await addWords(me('/api/me/brick-reports/words', { id: json.id, key: json.takeBackKey, words: 'My own words here' }));
    expect((await prisma.brickReportNote.findUniqueOrThrow({ where: { id: json.id as string } })).words).toBe('My own words here');
    expect(await forgetReportWordsOf(uuid)).toBe(1);
    const row = await prisma.brickReportNote.findUniqueOrThrow({ where: { id: json.id as string } });
    expect(row).toMatchObject({ words: '', wordsAt: null, takenBackAt: null });
    expect(await reportProblem(await problemOf(json.id))).toMatchObject({ times: 1, withWords: 0 });
  });

  it('a Brick sends at most so many notes a day, whatever key it runs on', async () => {
    const day = new Date('2030-01-02T10:00:00Z');
    const brick = (await createBrick({ ownerId: sara, name: 'Busy' })).id;
    bricks.add(brick);
    for (let i = 0; i < NOTES_PER_BRICK_PER_DAY; i++) {
      const outcome = await recordReportNote(idea(brick, `weekly_${i}`), day);
      expect(outcome.sent).toBe(true);
      if (outcome.sent) keep(await problemOf(outcome.id));
    }
    expect(await recordReportNote(idea(brick, 'one_more'), day)).toEqual({ sent: false, reason: 'limit' });
    // The next day it can again
    const next = await recordReportNote(idea(brick, 'next_day'), new Date('2030-01-03T10:00:00Z'));
    expect(next.sent).toBe(true);
    if (next.sent) keep(await problemOf(next.id));
  });

  it('refuses a note from a Brick that is not there, a room bot or a deleted Brick', async () => {
    expect((await send(note(randomUUID(), 'gone'))).json).toEqual({ sent: false, reason: 'unknown_brick' });
    const universe = await prisma.universe.create({ data: { slug: `r-${tag}`, name: 'Report test', ownerId: sara } });
    try {
      const world = await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } });
      const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
      const roomBot = await prisma.bot.create({ data: { roomId: room.id, name: 'Room bot', createdById: sara, behaviorConfig: {} } });
      expect((await send(note(roomBot.id, 'room'))).json).toEqual({ sent: false, reason: 'unknown_brick' });
    } finally {
      await prisma.universe.delete({ where: { id: universe.id } });
    }
    const gone = (await createBrick({ ownerId: sara, name: 'Gone' })).id;
    bricks.add(gone);
    await prisma.bot.update({ where: { id: gone }, data: { deletedAt: new Date(), goneAt: new Date(Date.now() + 86_400_000), enabledBeforeDelete: true, enabled: false } });
    expect((await send(note(gone, 'deleted'))).json).toEqual({ sent: false, reason: 'unknown_brick' });
  });

  it('the chat takes a note back with its key within 24 hours; a wrong key or too late does nothing', async () => {
    const { json } = await send(note(saraBrick, 'take_back', { area: 'map' }));
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
    expect(emptied).toMatchObject({ words: '', wordsAt: null, context: null, personKey: null, problemId: null });
    expect(emptied.takenBackAt).not.toBeNull();
    expect(await prisma.brickReportProblem.count({ where: { operation: `take_back_${tag}` } })).toBe(0);
  });

  it('a problem a taken-back note started reads as the notes left', async () => {
    const [saraBrick, omarBrick] = await freshPair();
    const opener = await send(note(saraBrick, 'share', { kind: 'cant_do', failure: 'missing_ability' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await send(note(omarBrick, 'share', { kind: 'cant_do', failure: 'missing_ability', personKey: `person:omar-${tag}` }));
    const problemId = await problemOf(opener.json.id);
    expect(await problemOf(later.json.id)).toBe(problemId);
    expect(await takeBackReportNote(opener.json.id as string, opener.json.takeBackKey as string)).toEqual({ takenBack: true });
    const left = await prisma.brickReportProblem.findUniqueOrThrow({ where: { id: problemId } });
    expect(left.lastSeenAt.getTime()).toBe((await prisma.brickReportNote.findUniqueOrThrow({ where: { id: later.json.id as string } })).createdAt.getTime());
    expect(await reportProblem(problemId)).toMatchObject({ title: 'Can’t do it yet: Pages', operation: `share_${tag}`, times: 1, bricks: 1 });
  });

  it('deleting the Brick keeps its notes counted, product-only, with no link to the Brick', async () => {
    const brick = (await createBrick({ ownerId: sara, name: 'Leaving' })).id;
    const { json } = await send(note(brick, 'leaving'));
    const problemId = await problemOf(json.id);
    await prisma.bot.delete({ where: { id: brick } });
    const row = await prisma.brickReportNote.findUniqueOrThrow({ where: { id: json.id as string } });
    expect(row.botId).toBeNull();
    expect(await reportProblem(problemId)).toMatchObject({ times: 1 });
  });

  it('one person cannot push a problem to High alone: Bricks of one owner count once, guests count 1 each and 2 at most', async () => {
    const own: string[] = [];
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']) own.push((await createBrick({ ownerId: sara, name })).id);
    own.forEach((id) => bricks.add(id));
    for (const [i, id] of own.entries()) await send(note(id, 'voice_drop', { area: 'voice', personKey: `guest:g${i}-${tag}` }));
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
    const [saraBrick, omarBrick] = await freshPair();
    const big = await send(note(saraBrick, 'sign_out', { area: 'apps', draftWords: 'Tools vanish' }));
    await send(note(omarBrick, 'sign_out', { area: 'apps', personKey: `person:omar-${tag}` }));
    const small = await send(note(saraBrick, 'weekly', { kind: 'idea', area: 'apps', effect: 'idea', failure: 'idea' }));
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
    // Draft words were never sent, so nothing to show
    expect(shown).toMatchObject({ sample: [], withWords: 0 });
    for (const secret of [saraBrick, omarBrick, 'personKey', 'botId']) expect(JSON.stringify(shown)).not.toContain(secret);
  });

  it('back to Fixed once every note from after the fix is taken back, in either order; a move by hand stands', async () => {
    const [saraBrick, omarBrick] = await freshPair();
    const first = await send(note(saraBrick, 'order', { area: 'memory' }));
    const problemId = await problemOf(first.json.id);
    for (const takeOpenerFirst of [true, false]) {
      await setReportState(problemId, 'fixed');
      const opener = await send(note(saraBrick, 'order', { area: 'memory' }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const later = await send(note(omarBrick, 'order', { area: 'memory', personKey: `person:omar-${tag}` }));
      expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
      const [one, two] = takeOpenerFirst ? [opener, later] : [later, opener];
      await takeBackReportNote(one.json.id as string, one.json.takeBackKey as string);
      expect(await reportProblem(problemId)).toMatchObject({ state: 'new' });
      await takeBackReportNote(two.json.id as string, two.json.takeBackKey as string);
      expect(await reportProblem(problemId)).toMatchObject({ state: 'fixed', cameBack: false });
    }
    // Back to New by hand: a person's call, and taking notes back leaves it
    const opener = await send(note(saraBrick, 'order', { area: 'memory' }));
    await setReportState(problemId, 'new');
    await takeBackReportNote(opener.json.id as string, opener.json.takeBackKey as string);
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new' });
  });

  it('a note whose clock read came before the reopening but joined after it still holds the problem open; a move by hand at the same moment stands (CodeRabbit)', async () => {
    const [saraBrick, omarBrick] = await freshPair();
    const base = new Date();
    const at = (ms: number) => new Date(base.getTime() + ms);
    const first = await recordReportNote(idea(saraBrick, 'clock'), at(0));
    if (!first.sent) throw new Error('not sent');
    const problemId = await problemOf(first.id);
    await setReportState(problemId, 'fixed', at(1000));
    // The opener takes the lock first; the other read its clock earlier but joins after it
    const opener = await recordReportNote(idea(saraBrick, 'clock'), at(3000));
    const joined = await recordReportNote(idea(omarBrick, 'clock'), at(2000));
    if (!opener.sent || !joined.sent) throw new Error('not sent');
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
    await takeBackReportNote(opener.id, opener.takeBackKey, at(4000));
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
    await takeBackReportNote(joined.id, joined.takeBackKey, at(5000));
    expect(await reportProblem(problemId)).toMatchObject({ state: 'fixed', cameBack: false });
    // Back to New by hand at the very moment a note reopened it: still the person's call
    const again = await recordReportNote(idea(saraBrick, 'clock'), at(6000));
    if (!again.sent) throw new Error('not sent');
    await setReportState(problemId, 'new', at(6000));
    await takeBackReportNote(again.id, again.takeBackKey, at(7000));
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new' });
  });

  it('moves a problem between tabs, and a note on a fixed problem brings it back to New', async () => {
    const [saraBrick, omarBrick] = await freshPair();
    const first = await send(note(saraBrick, 'memory', { area: 'memory' }));
    const problemId = await problemOf(first.json.id);
    mockUser.current = { id: sara, email: `sara-${tag}@example.test` };
    expect((await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }))).status).toBe(403);
    mockUser.current = { id: boss, email: 'boss@example.test' };
    const moved = await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    expect(moved.status).toBe(200);
    expect((await reportInbox('fixed')).problems.some((row) => row.id === problemId)).toBe(true);
    await send(note(omarBrick, 'memory', { area: 'memory' }));
    const back = await reportProblem(problemId);
    expect(back).toMatchObject({ state: 'new', cameBack: true });
    expect(back?.reasons).toContainEqual({ label: 'Came back after a fix', points: 6 });
    // Taking back the note that brought it back puts it back to Fixed; with a later note still there, it stays open
    const fixedAgain = await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    expect(fixedAgain.status).toBe(200);
    const reopen = await send(note(saraBrick, 'memory', { area: 'memory' }));
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
    expect(await takeBackReportNote(reopen.json.id as string, reopen.json.takeBackKey as string)).toEqual({ takenBack: true });
    expect(await reportProblem(problemId)).toMatchObject({ state: 'fixed', cameBack: false });
    expect((await reportInbox('new')).problems.some((row) => row.id === problemId)).toBe(false);
    await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    const opener = await send(note(saraBrick, 'memory', { area: 'memory' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(note(omarBrick, 'memory', { area: 'memory', personKey: `person:omar-${tag}` }));
    await takeBackReportNote(opener.json.id as string, opener.json.takeBackKey as string);
    expect(await reportProblem(problemId)).toMatchObject({ state: 'new', cameBack: true });
    // Moved by hand after it came back: taking the note back leaves the person's call as it is
    await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'fixed' } }), params({ id: problemId }));
    const third = await send(note(saraBrick, 'memory', { area: 'memory' }));
    await problemPatch(request(`/api/admin/brick-reports/${problemId}`, { method: 'PATCH', body: { state: 'working' } }), params({ id: problemId }));
    await takeBackReportNote(third.json.id as string, third.json.takeBackKey as string);
    expect(await reportProblem(problemId)).toMatchObject({ state: 'working' });

    const missing = await problemPatch(request(`/api/admin/brick-reports/${randomUUID()}`, { method: 'PATCH', body: { state: 'new' } }), params({ id: randomUUID() }));
    expect(missing.status).toBe(404);
  });
});
