/**
 * What a bot remembers about a person, and Forget, against a real database (game #2003): what only the database can
 * show. Two accounts: a person sees and forgets their own list and nobody else's, a bot's owner and managers never read
 * it, and a forgotten thing stays gone however it comes back (a stale save, a restored row, a read on startup). Runs only
 * with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/bot-memory-person-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { memoryItemKey } from '@/lib/bot-memory-items';
import { forgetKeys, lockPeople, saveMemoryRow } from '@/lib/bot-memory-person';
import { GET as listMine } from '@/app/api/bots/[id]/my-memory/route';
import { POST as forgetMine } from '@/app/api/bots/[id]/my-memory/forget/route';
import { GET as readSaved, POST as save } from '@/app/api/bots/memory/[id]/route';
import { POST as forgetByKey } from '@/app/api/bots/memory/[id]/items/route';
import { POST as reportDropped } from '@/app/api/bots/memory/[id]/forgotten/route';
import { GET as privacy } from '@/app/api/bots/[id]/privacy/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;

const SERVICE_TOKEN = 'service-secret';
const tag = randomUUID().slice(0, 8);
const people: Record<string, { id: string; uuid: string }> = {};
let universeId = '';
let melodyId = '';
let saraBrick = '';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Who = 'sara' | 'omar' | 'root' | 'guest' | null;

function as(who: Who, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  session.mockResolvedValue(who ? { id: people[who].id, uuid: people[who].uuid, email: `${who}-${tag}@example.test`, name: who, tags: [], isSuperAdmin: who === 'root' } : null);
  return new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
}
function asBotServer(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  session.mockResolvedValue(null);
  return new NextRequest(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const COFFEE = 'coffee, no sugar';
const memoryOf = (extra: Record<string, unknown> = {}) => ({
  personalInfo: {
    name: 'Sara',
    preferences: [COFFEE, 'lo-fi'],
    facts: [['current_state', 'tired'], ['tired_mentioned_at', '1000']],
    lastInfoUpdate: 1000,
    heard: { name: { place: 'dm', with: [] }, [`pref:${COFFEE}`]: { place: 'dm', with: [] } },
    ...extra,
  },
  relationship: { firstMet: 1, lastMet: 2, totalConversations: 1, totalMessages: 2, importantEvents: [] },
  conversationHistory: [
    { sender: 'person', message: `I like ${COFFEE}`, timestamp: 5000 },
    { sender: 'person', message: 'What is the weather', timestamp: 6000 },
  ],
});

async function rows(botId: string, userUuid: string) {
  return prisma.botsMemory.findUnique({ where: { botId_userUuid: { botId, userUuid } } });
}
async function valuesOf(who: Who, botId: string): Promise<string[]> {
  const answer = await listMine(as(who, `/api/bots/${botId}/my-memory`), params(botId));
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { items: { value: string }[] }).items.map((item) => item.value);
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

run('what a bot remembers about a person (real database)', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    for (const name of ['sara', 'omar', 'root', 'guest']) {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name, isGuest: name === 'guest' } });
      people[name] = { id: user.id, uuid: user.uuid };
    }
    const universe = await prisma.universe.create({ data: { slug: `mem-${tag}`, name: 'Memory', ownerId: people.omar.id, isPublic: true } });
    universeId = universe.id;
    const world = await prisma.world.create({ data: { universeId, slug: 'hq', name: 'HQ' } });
    const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    melodyId = (await prisma.bot.create({ data: { roomId: room.id, name: 'Melody', createdById: people.omar.id } })).id;
    saraBrick = (await createBrick({ ownerId: people.sara.id, name: 'Brick' })).id;
  });

  afterAll(async () => {
    const botIds = [melodyId, saraBrick].filter(Boolean);
    await prisma.botMemoryItemForget.deleteMany({ where: { botId: { in: botIds } } });
    await prisma.botMemoryForget.deleteMany({ where: { botId: { in: botIds } } });
    await prisma.botsMemory.deleteMany({ where: { botId: { in: botIds } } });
    await prisma.botFile.deleteMany({ where: { botId: { in: botIds } } });
    if (universeId) await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.bot.deleteMany({ where: { id: { in: botIds } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(people).map((person) => person.id) } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const botIds = [melodyId, saraBrick];
    await prisma.botMemoryItemForget.deleteMany({ where: { botId: { in: botIds } } });
    await prisma.botMemoryForget.deleteMany({ where: { botId: { in: botIds } } });
    await prisma.botsMemory.deleteMany({ where: { botId: { in: botIds } } });
    for (const botId of botIds) {
      await prisma.botsMemory.create({ data: { botId, userUuid: people.sara.uuid, userId: people.sara.id, isGuest: false, memories: memoryOf() } });
    }
    // Omar's own, so the two lists are told apart
    await prisma.botsMemory.create({ data: { botId: melodyId, userUuid: people.omar.uuid, userId: people.omar.id, isGuest: false, memories: { personalInfo: { name: 'Omar', preferences: ['jazz'], facts: [], lastInfoUpdate: 1 } } } });
  });

  it('lists a person’s own things on their own Brick, and on someone else’s bot', async () => {
    expect(await valuesOf('sara', saraBrick)).toEqual(expect.arrayContaining(['Sara', COFFEE, 'lo-fi', 'tired']));
    expect(await valuesOf('sara', melodyId)).toEqual(expect.arrayContaining(['Sara', COFFEE]));
    expect(await valuesOf('omar', melodyId)).toEqual(expect.arrayContaining(['Omar', 'jazz']));
  });

  it('never lets a bot’s owner, its managers or a super admin read another person’s list', async () => {
    // Omar made Melody and owns its universe: his list on it is his own
    expect(await valuesOf('omar', melodyId)).not.toContain(COFFEE);
    expect(await valuesOf('root', melodyId)).toEqual([]);
    // Sara's Brick is not there for anyone else, a super admin included
    for (const who of ['omar', 'root'] as const) {
      const answer = await listMine(as(who, `/api/bots/${saraBrick}/my-memory`), params(saraBrick));
      expect(answer.status).toBe(404);
      const forgot = await forgetMine(as(who, `/api/bots/${saraBrick}/my-memory/forget`, { everything: true }), params(saraBrick));
      expect(forgot.status).toBe(404);
    }
    expect(await rows(saraBrick, people.sara.uuid)).not.toBeNull();
    // The request carries no "who": a person named in the query changes nothing
    const answer = await listMine(as('omar', `/api/bots/${melodyId}/my-memory?userUuid=${people.sara.uuid}&userId=${people.sara.id}`), params(melodyId));
    expect(((await answer.json()) as { items: { value: string }[] }).items.map((item) => item.value)).not.toContain(COFFEE);
  });

  it('answers a guest and nobody signed in with a refusal', async () => {
    expect((await listMine(as(null, `/api/bots/${melodyId}/my-memory`), params(melodyId))).status).toBe(401);
    expect((await listMine(as('guest', `/api/bots/${melodyId}/my-memory`), params(melodyId))).status).toBe(403);
    expect((await listMine(as('sara', '/api/bots/nope/my-memory'), params('nope'))).status).toBe(404);
  });

  it('forgets one thing at once: gone from the list and the row, with what was built from it, and nothing else', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    const answer = await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ forgotten: 1, everything: false });
    expect(await valuesOf('sara', melodyId)).not.toContain(COFFEE);
    const row = await rows(melodyId, people.sara.uuid);
    const text = JSON.stringify(row?.memories);
    expect(text).not.toContain(COFFEE);
    expect(text).toContain('What is the weather');
    expect(text).toContain('lo-fi');
    // Her other bot, and Omar's list, are untouched
    expect(await valuesOf('sara', saraBrick)).toContain(COFFEE);
    expect(await valuesOf('omar', melodyId)).toEqual(expect.arrayContaining(['Omar', 'jazz']));
  });

  it('never writes over a save that arrived after the row was read', async () => {
    const stale = await rows(melodyId, people.sara.uuid);
    // The bot server saves one more thing after Orbit read the row, before the Forget is written
    await prisma.botsMemory.update({ where: { id: stale!.id }, data: { memories: memoryOf({ preferences: [COFFEE, 'lo-fi', 'chess'] }) } });
    await forgetKeys(melodyId, [stale!.userUuid], new Map([[memoryItemKey('pref', null, COFFEE), 'pref']]));
    const text = JSON.stringify((await rows(melodyId, people.sara.uuid))?.memories);
    expect(text).not.toContain(COFFEE);
    expect(text).toContain('chess');
  });

  it('takes turns with a save: a save that waits for a Forget is written without what it forgot', async () => {
    const chess = memoryItemKey('pref', null, 'chess');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A Forget in the middle of its transaction, holding the person's lock
    const forgetting = prisma.$transaction(async (tx) => {
      await lockPeople(tx, melodyId, [people.sara.uuid]);
      await tx.botMemoryItemForget.create({ data: { botId: melodyId, userUuid: people.sara.uuid, itemKey: chess, kind: 'pref', createdAt: new Date() } });
      await gate;
    });
    await settle();
    // A save that began before the Forget was written: it has to wait, and then it reads what was forgotten
    const saving = saveMemoryRow(melodyId, people.sara.uuid, memoryOf({ preferences: [COFFEE, 'chess'] }), (tx, clean) =>
      tx.botsMemory.update({ where: { botId_userUuid: { botId: melodyId, userUuid: people.sara.uuid } }, data: { memories: clean as Prisma.InputJsonValue } }),
    );
    await settle();
    release();
    await forgetting;
    await saving;
    const text = JSON.stringify((await rows(melodyId, people.sara.uuid))?.memories);
    expect(text).not.toContain('chess');
    expect(text).toContain(COFFEE);
  });

  it('takes turns with a save: a Forget that waits for a save takes out what it wrote', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = prisma.$transaction(async (tx) => {
      await lockPeople(tx, melodyId, [people.sara.uuid]);
      await tx.botsMemory.update({ where: { botId_userUuid: { botId: melodyId, userUuid: people.sara.uuid } }, data: { memories: memoryOf({ preferences: [COFFEE, 'chess'] }) } });
      await gate;
    });
    await settle();
    const forgetting = forgetKeys(melodyId, [people.sara.uuid], new Map([[memoryItemKey('pref', null, 'chess'), 'pref']]));
    await settle();
    release();
    await saving;
    await forgetting;
    expect(JSON.stringify((await rows(melodyId, people.sara.uuid))?.memories)).not.toContain('chess');
  });

  it('a late report of a Forget keeps the time the person asked, and never makes an older Forget newer', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    const asked = Date.now() - 60 * 60 * 1000;
    const late = await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: id, kind: 'pref', at: asked }), params(melodyId));
    expect(late.status).toBe(200);
    expect((await prisma.botMemoryItemForget.findFirstOrThrow({ where: { botId: melodyId, itemKey: id } })).createdAt.getTime()).toBe(asked);
    // The same thing reported again with an older time: the newer Forget stays
    await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: id, kind: 'pref', at: asked - 1000 }), params(melodyId));
    expect((await prisma.botMemoryItemForget.findFirstOrThrow({ where: { botId: melodyId, itemKey: id } })).createdAt.getTime()).toBe(asked);
    // A time in the future is not believed
    const future = memoryItemKey('pref', null, 'chess');
    await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: future, kind: 'pref', at: Date.now() + 10 * 60 * 60 * 1000 }), params(melodyId));
    expect((await prisma.botMemoryItemForget.findFirstOrThrow({ where: { botId: melodyId, itemKey: future } })).createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    // An old time is kept as the bot server sent it: its report is the truth of when they asked
    const old = memoryItemKey('pref', null, 'lo-fi');
    const longAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: old, kind: 'pref', at: longAgo }), params(melodyId));
    expect((await prisma.botMemoryItemForget.findFirstOrThrow({ where: { botId: melodyId, itemKey: old } })).createdAt.getTime()).toBe(longAgo);
    // Not a time at all is a bad request
    expect((await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: id, kind: 'pref', at: 'x' }), params(melodyId))).status).toBe(400);
  });

  const prefsOf = (row: { memories: unknown } | null | undefined) => ((row?.memories as { personalInfo?: { preferences?: string[] } } | null)?.personalInfo?.preferences ?? []);

  it('a late report of a Forget leaves in the saved row what the person said after they asked', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    const asked = Date.now() - 60 * 60 * 1000;
    // The row already holds the thing said again 30 minutes after they asked (a save reached Orbit before the retried report)
    const again = memoryOf({ drawnFrom: { [`pref:${COFFEE}`]: asked + 30 * 60 * 1000 } });
    await save(asBotServer(`/api/bots/memory/${melodyId}`, { memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: again }] }), params(melodyId));
    await settle();
    await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: id, kind: 'pref', at: asked }), params(melodyId));
    expect(prefsOf(await rows(melodyId, people.sara.uuid))).toContain(COFFEE);
    // Said before they asked, the same late report takes it out of the row
    const before = memoryOf({ drawnFrom: { [`pref:${COFFEE}`]: asked - 30 * 60 * 1000 } });
    await save(asBotServer(`/api/bots/memory/${melodyId}`, { memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: before }] }), params(melodyId));
    await settle();
    await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: id, kind: 'pref', at: asked }), params(melodyId));
    expect(prefsOf(await rows(melodyId, people.sara.uuid))).not.toContain(COFFEE);
  });

  it('keeps only a key, never the words', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    const kept = await prisma.botMemoryItemForget.findMany({ where: { botId: melodyId } });
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ userUuid: people.sara.uuid, itemKey: id, kind: 'pref', droppedAt: null });
    expect(JSON.stringify(kept)).not.toContain('coffee');
  });

  it('forgetting what is gone already is fine and writes nothing', async () => {
    const answer = await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: 'f'.repeat(32) }), params(melodyId));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ forgotten: 0, everything: false });
    expect(await prisma.botMemoryItemForget.count({ where: { botId: melodyId } })).toBe(0);
  });

  it('refuses a body that names someone else or anything but a thing or everything', async () => {
    for (const body of [{ itemId: 'x', userUuid: people.omar.uuid }, {}, { everything: false }, { itemId: '' }]) {
      expect((await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, body), params(melodyId))).status).toBe(400);
    }
  });

  it('keeps it gone when the bot server saves a copy it still held', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    // The bot server's memory still holds it and saves everything
    const answer = await save(asBotServer(`/api/bots/memory/${melodyId}`, { memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: memoryOf() }] }), params(melodyId));
    expect(answer.status).toBe(200);
    // ... and is told to drop it, by key
    const body = (await answer.json()) as { forgetItems?: { itemKey: string; userUuid: string }[] };
    expect(body.forgetItems).toEqual([expect.objectContaining({ itemKey: id, userUuid: people.sara.uuid, at: expect.any(Number) })]);
    await settle();
    expect(JSON.stringify((await rows(melodyId, people.sara.uuid))?.memories)).not.toContain(COFFEE);
    expect(await valuesOf('sara', melodyId)).toEqual(expect.arrayContaining(['Sara', 'lo-fi']));
  });

  it('keeps it gone in an immediate save too', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    await save(asBotServer(`/api/bots/memory/${melodyId}`, { saveType: 'immediate', userUuid: people.sara.uuid, isGuest: false, emotions: { botEmotion: {} }, memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: memoryOf() }] }), params(melodyId));
    await settle();
    expect(JSON.stringify((await rows(melodyId, people.sara.uuid))?.memories)).not.toContain(COFFEE);
  });

  it('keeps it gone when an old row is restored and read back on startup', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    // A restore puts the old row back, with the thing and the chat line in it
    await prisma.botsMemory.update({ where: { botId_userUuid: { botId: melodyId, userUuid: people.sara.uuid } }, data: { memories: memoryOf() } });
    expect(await valuesOf('sara', melodyId)).not.toContain(COFFEE);
    const read = await readSaved(asBotServer(`/api/bots/memory/${melodyId}`), params(melodyId));
    const text = JSON.stringify(((await read.json()) as { memories: unknown[] }).memories);
    expect(text).not.toContain(COFFEE);
    expect(text).toContain('lo-fi');
  });

  it('learns it again when the person says it again afterwards', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    const later = memoryOf({ drawnFrom: { [`pref:${COFFEE}`]: Date.now() + 60_000 } });
    await save(asBotServer(`/api/bots/memory/${melodyId}`, { memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: later }] }), params(melodyId));
    await settle();
    expect(await valuesOf('sara', melodyId)).toContain(COFFEE);
  });

  it('tells the bot server until it reports it dropped the thing, and keeps the Forget after', async () => {
    const id = memoryItemKey('pref', null, COFFEE);
    await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { itemId: id }), params(melodyId));
    const asked = await privacy(asBotServer(`/api/bots/${melodyId}/privacy`), params(melodyId));
    const notice = ((await asked.json()) as { forgetItems?: { id: string; itemKey: string }[] }).forgetItems;
    expect(notice).toHaveLength(1);
    const reported = await reportDropped(asBotServer(`/api/bots/memory/${melodyId}/forgotten`, { itemIds: [notice![0].id] }), params(melodyId));
    expect(await reported.json()).toMatchObject({ itemsAcknowledged: 1 });
    const again = await privacy(asBotServer(`/api/bots/${melodyId}/privacy`), params(melodyId));
    expect(((await again.json()) as { forgetItems?: unknown }).forgetItems).toBeUndefined();
    // The Forget itself stays, so a stale copy still cannot bring it back
    expect(await prisma.botMemoryItemForget.count({ where: { botId: melodyId, itemKey: id } })).toBe(1);
    await save(asBotServer(`/api/bots/memory/${melodyId}`, { memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: memoryOf() }] }), params(melodyId));
    await settle();
    expect(JSON.stringify((await rows(melodyId, people.sara.uuid))?.memories)).not.toContain(COFFEE);
  });

  it('takes a "forget that" said in the chat by its key, even for a thing Orbit has not saved yet', async () => {
    const heldOnly = memoryItemKey('pref', null, 'chess');
    const refused = await forgetByKey(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ userUuid: people.sara.uuid, itemKey: heldOnly, kind: 'pref' }) }), params(melodyId));
    expect(refused.status).toBe(401);
    const answer = await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: heldOnly, kind: 'pref' }), params(melodyId));
    expect(answer.status).toBe(200);
    await save(asBotServer(`/api/bots/memory/${melodyId}`, { memories: [{ userUuid: people.sara.uuid, isGuest: false, memories: memoryOf({ preferences: ['chess', 'lo-fi'] }) }] }), params(melodyId));
    await settle();
    expect(await valuesOf('sara', melodyId)).not.toContain('chess');
    const saved = await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: memoryItemKey('pref', null, COFFEE), kind: 'pref' }), params(melodyId));
    expect(saved.status).toBe(200);
    expect(await valuesOf('sara', melodyId)).not.toContain(COFFEE);
    const bad = await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: 'not a key', kind: 'pref' }), params(melodyId));
    expect(bad.status).toBe(400);
  });

  it('takes a "forget that" for a row whose memories are empty (null) without failing', async () => {
    await prisma.botsMemory.update({ where: { botId_userUuid: { botId: melodyId, userUuid: people.sara.uuid } }, data: { memories: Prisma.DbNull } });
    const answer = await forgetByKey(asBotServer(`/api/bots/memory/${melodyId}/items`, { userUuid: people.sara.uuid, itemKey: memoryItemKey('pref', null, COFFEE), kind: 'pref' }), params(melodyId));
    expect(answer.status).toBe(200);
    expect(await prisma.botMemoryItemForget.count({ where: { botId: melodyId, userUuid: people.sara.uuid, itemKey: memoryItemKey('pref', null, COFFEE) } })).toBe(1);
  });

  it('forgets everything even before anything was saved: the bot server is still told to drop her from memory', async () => {
    await prisma.botsMemory.deleteMany({ where: { botId: melodyId, userUuid: people.sara.uuid } });
    const answer = await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { everything: true }), params(melodyId));
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { forgotten: number }).forgotten).toBe(0);
    expect(await prisma.botMemoryForget.count({ where: { botId: melodyId, userUuid: people.sara.uuid } })).toBe(1);
    // By the email the bot server may name her by too
    expect(await prisma.botMemoryForget.count({ where: { botId: melodyId, userUuid: `sara-${tag}@example.test` } })).toBe(1);
    // Omar's list is untouched
    expect(await valuesOf('omar', melodyId)).toEqual(expect.arrayContaining(['Omar', 'jazz']));
  });

  it('forgets everything: the row, the feelings and the lines of the chat; their files stay, and so does everyone else', async () => {
    await prisma.botFile.create({ data: { botId: melodyId, number: 1, ownerId: people.sara.id, source: 'person', kind: 'document', name: 'passport.pdf', chatKind: 'dm', chatRef: 'r1' } });
    const answer = await forgetMine(as('sara', `/api/bots/${melodyId}/my-memory/forget`, { everything: true }), params(melodyId));
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { forgotten: number }).forgotten).toBeGreaterThan(0);
    expect(await rows(melodyId, people.sara.uuid)).toBeNull();
    expect(await valuesOf('sara', melodyId)).toEqual([]);
    expect(await prisma.botFile.count({ where: { botId: melodyId, ownerId: people.sara.id } })).toBe(1);
    expect(await valuesOf('omar', melodyId)).toEqual(expect.arrayContaining(['Omar', 'jazz']));
    // The bot server is told to drop her whole, as for a Forget a manager pressed, and her Brick is untouched
    expect(await prisma.botMemoryForget.count({ where: { botId: melodyId, userUuid: people.sara.uuid } })).toBe(1);
    // Also by her email, which has no saved row, so what the bot server holds under it is dropped too
    expect(await prisma.botMemoryForget.count({ where: { botId: melodyId, userUuid: `sara-${tag}@example.test` } })).toBe(1);
    expect(await valuesOf('sara', saraBrick)).toContain(COFFEE);
    // A row restored afterwards is as empty as this one
    await prisma.botsMemory.create({ data: { botId: melodyId, userUuid: people.sara.uuid, userId: people.sara.id, isGuest: false, memories: memoryOf() } });
    expect(await valuesOf('sara', melodyId)).toEqual([]);
  });
});
