/**
 * A Brick's files in one place (game #2003), against a real database: only the owner's own files of their own Brick,
 * what it made apart from what they sent, how each was shared, Delete only for what they sent (with the uploader's copy
 * queued for removal and the text kept from it gone), and nothing for anyone else. Runs only with ROLES_DB_TEST=yes and a
 * DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/brick-files-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { GET as listFiles } from '@/app/api/bricks/[id]/files/route';
import { DELETE as deleteFile } from '@/app/api/bricks/[id]/files/[fileId]/route';
import { GET as pending, POST as confirm } from '@/app/api/bot-files/removals/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;
const SERVICE_TOKEN = 'service-secret';
const tag = randomUUID().slice(0, 8);
const people: Record<string, { id: string; uuid: string }> = {};
let brickId = '';
let otherBrickId = '';
const DAY = 24 * 60 * 60 * 1000;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const fileParams = (id: string, fileId: string) => ({ params: Promise.resolve({ id, fileId }) });
const uploaderId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Who = 'sara' | 'omar' | 'root' | 'guest' | null;
function as(who: Who, path: string, method = 'GET') {
  session.mockResolvedValue(who ? { id: people[who].id, uuid: people[who].uuid, email: `${who}-${tag}@example.test`, name: who, tags: [], isSuperAdmin: who === 'root' } : null);
  return new NextRequest(`http://localhost${path}`, { method });
}
const botServer = (path: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });

interface Listed {
  name: string;
  audience: string;
  store: { bucket?: string; fileId?: string };
}
interface FilesAnswer {
  made: { files: Listed[]; total: number; artifacts: number };
  sent: { files: Listed[]; total: number };
  computer: unknown;
  count: number;
  bytes: number;
}

let counter = 0;
function file(botId: string, ownerId: string | null, extra: Record<string, unknown> = {}) {
  counter += 1;
  return prisma.botFile.create({
    data: { botId, number: counter, ownerId, source: 'person', kind: 'document', name: `file-${counter}.pdf`, sizeBytes: 1000, bucket: 'refs', fileId: `${uploaderId(counter)}.pdf`, chatKind: 'dm', chatRef: 'room-1', seenBy: [], ...extra },
  });
}

run('a Brick’s files (real database)', () => {
  beforeAll(async () => {
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    for (const name of ['sara', 'omar', 'root', 'guest']) {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name, isGuest: name === 'guest' } });
      people[name] = { id: user.id, uuid: user.uuid };
    }
    brickId = (await createBrick({ ownerId: people.sara.id, name: 'Brick' })).id;
    otherBrickId = (await createBrick({ ownerId: people.sara.id, name: 'Recipes' })).id;
  });

  afterAll(async () => {
    await prisma.botFileRemoval.deleteMany({ where: { botId: { in: [brickId, otherBrickId] } } });
    await prisma.artifact.deleteMany({ where: { makerBotId: { in: [brickId, otherBrickId] } } });
    await prisma.bot.deleteMany({ where: { id: { in: [brickId, otherBrickId] } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(people).map((person) => person.id) } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.botFile.deleteMany({ where: { botId: { in: [brickId, otherBrickId] } } });
    await prisma.botFileRemoval.deleteMany({ where: { botId: { in: [brickId, otherBrickId] } } });
    await prisma.artifact.deleteMany({ where: { makerBotId: { in: [brickId, otherBrickId] } } });
  });

  async function read(who: Who, id = brickId) {
    const answer = await listFiles(as(who, `/api/bricks/${id}/files`), params(id));
    return { status: answer.status, body: (await answer.json()) as FilesAnswer };
  }

  it('lists what it made, what they sent, and how many things it made in all, with their sizes', async () => {
    await file(brickId, people.sara.id, { source: 'bot', name: 'visa-receipt.pdf', sizeBytes: 212_000, createdAt: new Date(Date.now() - 3 * DAY) });
    await file(brickId, people.sara.id, { source: 'bot', name: 'bakery.xlsx', sizeBytes: 48_000, createdAt: new Date(Date.now() - 2 * DAY) });
    await file(brickId, people.sara.id, { source: 'bot', name: 'older.png', kind: 'image', sizeBytes: 5_000, createdAt: new Date(Date.now() - 9 * DAY) });
    await file(brickId, people.sara.id, { name: 'passport-and-ticket.pdf', sizeBytes: 1_400_000 });
    await prisma.artifact.create({ data: { ownerId: people.sara.id, makerBotId: brickId, makerName: 'Brick', title: 'Trip page', kind: 'page' } });
    const { status, body } = await read('sara');
    expect(status).toBe(200);
    // The latest two it made are named, newest first; the rest are one tap away
    expect(body.made.files.map((f) => f.name)).toEqual(['bakery.xlsx', 'visa-receipt.pdf']);
    expect(body.made).toMatchObject({ total: 4, artifacts: 1 });
    expect(body.sent.files.map((f) => f.name)).toEqual(['passport-and-ticket.pdf']);
    expect(body.sent.total).toBe(1);
    expect(body.count).toBe(4);
    expect(body.bytes).toBe(212_000 + 48_000 + 5_000 + 1_400_000);
    expect(body.computer).toBeNull();
    expect(body.made.files[0]).toMatchObject({ store: { bucket: 'refs', fileId: expect.stringMatching(/\.pdf$/) } });
  });

  it('says how each file was shared when it came: only the Brick and the person, or in a nearby chat with others there', async () => {
    await file(brickId, people.sara.id, { name: 'dm.pdf', chatKind: 'dm', seenBy: [people.sara.uuid] });
    await file(brickId, people.sara.id, { name: 'alone-nearby.pdf', chatKind: 'nearby', seenBy: [people.sara.uuid] });
    await file(brickId, people.sara.id, { name: 'crowd.pdf', chatKind: 'nearby', seenBy: [people.sara.uuid, 'omar-uuid', 'noura-uuid'] });
    // From before it was recorded who was there: never called private
    await file(brickId, people.sara.id, { name: 'old-nearby.pdf', chatKind: 'nearby', seenBy: [] });
    const { body } = await read('sara');
    const byName = Object.fromEntries(body.sent.files.map((f) => [f.name, f.audience]));
    expect(byName).toEqual({ 'dm.pdf': 'you', 'alone-nearby.pdf': 'you', 'crowd.pdf': 'chat', 'old-nearby.pdf': 'chat' });
  });

  it('lists only this Brick’s files and only the owner’s own, never another person’s or another Brick’s', async () => {
    await file(brickId, people.sara.id, { name: 'mine.pdf' });
    await file(brickId, people.omar.id, { name: 'omars.pdf' });
    await file(brickId, null, { name: 'a-guests.pdf', expiresAt: new Date(Date.now() + DAY) });
    await file(otherBrickId, people.sara.id, { name: 'recipes.pdf' });
    const { body } = await read('sara');
    expect(body.sent.files.map((f) => f.name)).toEqual(['mine.pdf']);
    expect((await read('sara', otherBrickId)).body.sent.files.map((f) => f.name)).toEqual(['recipes.pdf']);
  });

  it('leaves out a file that has gone', async () => {
    await file(brickId, people.sara.id, { name: 'expired.pdf', expiresAt: new Date(Date.now() - 1000) });
    await file(brickId, people.sara.id, { name: 'fresh.pdf' });
    expect((await read('sara')).body.sent.files.map((f) => f.name)).toEqual(['fresh.pdf']);
  });

  it('gives nobody else the list or a delete: not another person, not a super admin, not a guest', async () => {
    const mine = await file(brickId, people.sara.id);
    for (const who of ['omar', 'root'] as const) {
      expect((await read(who)).status).toBe(404);
      expect((await deleteFile(as(who, `/api/bricks/${brickId}/files/${mine.id}`, 'DELETE'), fileParams(brickId, mine.id))).status).toBe(404);
    }
    expect((await read('guest')).status).toBe(403);
    expect((await read(null)).status).toBe(401);
    expect((await read('sara', 'no-such-brick')).status).toBe(404);
    expect(await prisma.botFile.count({ where: { id: mine.id } })).toBe(1);
  });

  it('deletes a file they sent: gone from the list, its text with it, and its uploader copy queued for removal by place only', async () => {
    const sent = await file(brickId, people.sara.id, { name: 'passport.pdf' });
    await prisma.botFilePart.create({ data: { botFileId: sent.id, number: 1, start: 0, text: 'passport number 12345' } });
    const answer = await deleteFile(as('sara', `/api/bricks/${brickId}/files/${sent.id}`, 'DELETE'), fileParams(brickId, sent.id));
    expect(answer.status).toBe(200);
    expect(await prisma.botFile.count({ where: { id: sent.id } })).toBe(0);
    expect(await prisma.botFilePart.count({ where: { botFileId: sent.id } })).toBe(0);
    const removals = await prisma.botFileRemoval.findMany({ where: { botId: brickId } });
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ bucket: 'refs', fileId: sent.fileId });
    expect(JSON.stringify(removals)).not.toContain('passport');
    expect((await read('sara')).body.sent.total).toBe(0);
    // Again: it is not there
    expect((await deleteFile(as('sara', `/api/bricks/${brickId}/files/${sent.id}`, 'DELETE'), fileParams(brickId, sent.id))).status).toBe(404);
  });

  it('does not delete what the Brick made, someone else’s file, or a file of another Brick', async () => {
    const made = await file(brickId, people.sara.id, { source: 'bot' });
    const theirs = await file(brickId, people.omar.id);
    const elsewhere = await file(otherBrickId, people.sara.id);
    for (const row of [made, theirs, elsewhere]) {
      expect((await deleteFile(as('sara', `/api/bricks/${brickId}/files/${row.id}`, 'DELETE'), fileParams(brickId, row.id))).status).toBe(404);
      expect(await prisma.botFile.count({ where: { id: row.id } })).toBe(1);
    }
    expect(await prisma.botFileRemoval.count({ where: { botId: brickId } })).toBe(0);
  });

  it('queues no removal for a file that is only a link', async () => {
    const link = await file(brickId, people.sara.id, { bucket: null, fileId: null, url: 'https://example.test/a.pdf' });
    expect((await deleteFile(as('sara', `/api/bricks/${brickId}/files/${link.id}`, 'DELETE'), fileParams(brickId, link.id))).status).toBe(200);
    expect(await prisma.botFileRemoval.count({ where: { botId: brickId } })).toBe(0);
  });

  it('hands the bot server what to remove, and forgets it only when told it is done', async () => {
    const sent = await file(brickId, people.sara.id);
    await deleteFile(as('sara', `/api/bricks/${brickId}/files/${sent.id}`, 'DELETE'), fileParams(brickId, sent.id));
    expect((await pending(new NextRequest('http://localhost/api/bot-files/removals'))).status).toBe(401);
    const asked = await pending(botServer('/api/bot-files/removals'));
    const { removals } = (await asked.json()) as { removals: { id: string; bucket: string; fileId: string }[] };
    expect(removals.filter((removal) => removal.fileId === sent.fileId)).toHaveLength(1);
    const ids = removals.map((removal) => removal.id);
    const done = await confirm(botServer('/api/bot-files/removals', { method: 'POST', body: { ids } }));
    expect(done.status).toBe(200);
    expect(await prisma.botFileRemoval.count({ where: { id: { in: ids } } })).toBe(0);
    expect((await confirm(botServer('/api/bot-files/removals', { method: 'POST', body: { ids: [] } }))).status).toBe(400);
  });
});
