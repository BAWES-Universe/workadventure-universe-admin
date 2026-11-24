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
import { FILES_PAGE, MADE_SHOWN, SEARCH_MAX_LENGTH } from '@/lib/brick-files';
import { getServerLimits } from '@/lib/bot-limits';

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
  id: string;
  name: string;
  audience: string;
  store: { bucket?: string; fileId?: string };
}
interface FilesAnswer {
  made: { files: Listed[]; total: number; artifacts: number; fileTotal: number; nextCursor: string | null };
  sent: { files: Listed[]; total: number; nextCursor: string | null };
  computer: unknown;
  count: number;
  bytes: number;
}
interface PageAnswer {
  section: string;
  files: Listed[];
  total: number;
  nextCursor: string | null;
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

  /** One page of one list: `query` is what follows the ? in the address. */
  async function page(query: string, who: Who = 'sara', id = brickId) {
    const answer = await listFiles(as(who, `/api/bricks/${id}/files?${query}`), params(id));
    return { status: answer.status, body: (await answer.json()) as PageAnswer };
  }

  /** Every page of a list, one after the other, the way the game's "Show more" and its export walk it. */
  async function walk(section: 'made' | 'sent', extra = '', first?: { files: Listed[]; nextCursor: string | null }) {
    const names: string[] = [];
    const ids: string[] = [];
    let cursor: string | null = first ? first.nextCursor : null;
    for (const one of first?.files ?? []) {
      names.push(one.name);
      ids.push(one.id);
    }
    let pages = first ? 1 : 0;
    do {
      if (!first || cursor) {
        const { status, body } = await page(`section=${section}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(status).toBe(200);
        for (const one of body.files) {
          names.push(one.name);
          ids.push(one.id);
        }
        cursor = body.nextCursor;
        pages += 1;
      }
    } while (cursor);
    return { names, ids, pages };
  }

  /** `count` files at once, one a minute older than the last (or all at one moment), named name-1, name-2 ... newest first. */
  async function many(count: number, over: Record<string, unknown> = {}, { sameMoment = false, name = 'sent', owner = people.sara.id }: { sameMoment?: boolean; name?: string; owner?: string | null } = {}) {
    const base = Date.now() - 30 * 60 * 1000;
    const data = Array.from({ length: count }, (_, index) => {
      counter += 1;
      return { botId: brickId, number: counter, ownerId: owner, source: 'person', kind: 'document', name: `${name}-${index + 1}.pdf`, sizeBytes: 10, bucket: 'refs', fileId: `${uploaderId(counter)}.pdf`, chatKind: 'dm', chatRef: 'room-1', seenBy: [], createdAt: new Date(sameMoment ? base : base - index * 60 * 1000), ...over };
    });
    await prisma.botFile.createMany({ data });
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

  it('queues the uploader copy only when no other row still opens the same stored file, also when the last two are deleted at the same moment', async () => {
    const one = await file(brickId, people.sara.id, { fileId: 'shared-copy.pdf' });
    const two = await file(brickId, people.sara.id, { fileId: 'shared-copy.pdf' });
    const del = (id: string) => deleteFile(as('sara', `/api/bricks/${brickId}/files/${id}`, 'DELETE'), fileParams(brickId, id));
    // One of two: the other still opens that file, so it stays in the uploader
    expect((await del(one.id)).status).toBe(200);
    expect(await prisma.botFileRemoval.count({ where: { botId: brickId, fileId: 'shared-copy.pdf' } })).toBe(0);
    expect((await del(two.id)).status).toBe(200);
    expect(await prisma.botFileRemoval.count({ where: { botId: brickId, fileId: 'shared-copy.pdf' } })).toBe(1);
    // Both at the same moment: the file is not left behind
    const three = await file(brickId, people.sara.id, { fileId: 'shared-race.pdf' });
    const four = await file(brickId, people.sara.id, { fileId: 'shared-race.pdf' });
    const both = await Promise.all([del(three.id), del(four.id)]);
    expect(both.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await prisma.botFileRemoval.count({ where: { botId: brickId, fileId: 'shared-race.pdf' } })).toBe(1);
    await prisma.botFileRemoval.deleteMany({ where: { botId: brickId } });
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

  describe('more than the first look shows', () => {
    it('reaches every one of 130 sent files, newest first, none twice, and counts them all', async () => {
      await many(130);
      const { body } = await read('sara');
      expect(body.sent.files).toHaveLength(FILES_PAGE);
      expect(body.sent.total).toBe(130);
      expect(body.count).toBe(130);
      expect(body.bytes).toBe(1300);
      expect(body.sent.nextCursor).not.toBeNull();
      expect(body.sent.files[0].name).toBe('sent-1.pdf');
      const all = await walk('sent', '', body.sent);
      expect(all.names).toHaveLength(130);
      expect(new Set(all.ids).size).toBe(130);
      expect(all.names).toEqual(Array.from({ length: 130 }, (_, index) => `sent-${index + 1}.pdf`));
      expect(all.pages).toBe(Math.ceil(130 / FILES_PAGE));
    });

    it('lists no more than a page whatever is asked for, and says the first look is the last page when it is', async () => {
      await many(3);
      expect((await read('sara')).body.sent.nextCursor).toBeNull();
      await many(FILES_PAGE + 5, {}, { name: 'more' });
      for (const limit of ['1000', '0', '-4', 'many', '2.5']) {
        expect((await page(`section=sent&limit=${limit}`)).body.files.length).toBeLessThanOrEqual(FILES_PAGE);
      }
      expect((await page('section=sent&limit=2')).body.files).toHaveLength(2);
      expect((await page('section=sent')).body.total).toBe(FILES_PAGE + 8);
    });

    it('keeps every file in place when many share one moment', async () => {
      await many(FILES_PAGE * 2 + 7, {}, { sameMoment: true });
      const all = await walk('sent');
      expect(all.ids).toHaveLength(FILES_PAGE * 2 + 7);
      expect(new Set(all.ids).size).toBe(FILES_PAGE * 2 + 7);
    });

    it('shows more than two of what it made in the same list, with how many there are', async () => {
      await many(5, { source: 'bot' }, { name: 'made' });
      await prisma.artifact.create({ data: { ownerId: people.sara.id, makerBotId: brickId, makerName: 'Brick', title: 'A page', kind: 'page' } });
      const { body } = await read('sara');
      expect(body.made.files.map((f) => f.name)).toEqual(['made-1.pdf', 'made-2.pdf']);
      expect(MADE_SHOWN).toBe(2);
      expect(body.made).toMatchObject({ fileTotal: 5, artifacts: 1, total: 6 });
      expect(body.made.nextCursor).not.toBeNull();
      const all = await walk('made', '', body.made);
      expect(all.names).toEqual(['made-1.pdf', 'made-2.pdf', 'made-3.pdf', 'made-4.pdf', 'made-5.pdf']);
      // The two lists never mix
      await many(2, {}, { name: 'sent' });
      expect((await walk('made')).names).toHaveLength(5);
      expect((await walk('sent')).names).toHaveLength(2);
    });

    it('lists and counts only live files of the owner: not expired, not gone, not another person’s, not another Brick’s, not without a place', async () => {
      const limits = (await getServerLimits()).files;
      await many(3, {}, { name: 'mine' });
      await many(4, { expiresAt: new Date(Date.now() - 1000) }, { name: 'expired' });
      await many(2, { expiresAt: new Date(Date.now() + DAY) }, { name: 'guest-live', owner: null });
      await many(2, {}, { name: 'omars', owner: people.omar.id });
      await file(otherBrickId, people.sara.id, { name: 'elsewhere.pdf' });
      await many(2, { bucket: null, fileId: null, url: null }, { name: 'nowhere' });
      await many(2, { bucket: '', fileId: '' }, { name: 'empty-place' });
      await many(1, { bucket: null, fileId: null, url: 'https://example.test/x.pdf' }, { name: 'link' });
      if (limits.findable > 0) await many(2, { createdAt: new Date(Date.now() - (limits.findable + 1) * DAY) }, { name: 'too-old' });
      const first = await read('sara');
      const listed = (await walk('sent')).names;
      expect(listed.sort()).toEqual(['link-1.pdf', 'mine-1.pdf', 'mine-2.pdf', 'mine-3.pdf']);
      expect(first.body.sent.total).toBe(4);
      expect(first.body.count).toBe(4);
      expect((await page('section=sent')).body.total).toBe(4);
      // Nobody else gets any of it, and a page is for the owner only
      for (const who of ['omar', 'root'] as const) expect((await page('section=sent', who)).status).toBe(404);
      expect((await page('section=sent', 'guest')).status).toBe(403);
      expect((await page('section=sent', null)).status).toBe(401);
    });

    it('goes on from where it was when files are deleted meanwhile, even the one the page ended on', async () => {
      await many(120);
      const first = await read('sara');
      const next = first.body.sent.nextCursor as string;
      // The person deletes the last file they saw (the cursor's own), one earlier and one that comes later
      const ids = (await walk('sent')).ids;
      for (const id of [first.body.sent.files[FILES_PAGE - 1].id, first.body.sent.files[3].id, ids[FILES_PAGE + 4]]) {
        expect((await deleteFile(as('sara', `/api/bricks/${brickId}/files/${id}`, 'DELETE'), fileParams(brickId, id))).status).toBe(200);
      }
      const rest = await walk('sent', '', { files: [], nextCursor: next });
      // Everything after the page they saw is there once, in order, minus the one deleted from it
      const expected = ids.slice(FILES_PAGE).filter((id) => id !== ids[FILES_PAGE + 4]);
      expect(rest.ids).toEqual(expected);
      expect((await read('sara')).body.sent.total).toBe(117);
    });

    it('goes on when a file is added meanwhile: the new one is not mixed into pages already walked', async () => {
      await many(70);
      const first = await read('sara');
      await many(1, { createdAt: new Date() }, { name: 'brand-new' });
      const rest = await walk('sent', '', { files: [], nextCursor: first.body.sent.nextCursor });
      expect(rest.names).toEqual(Array.from({ length: 20 }, (_, index) => `sent-${FILES_PAGE + index + 1}.pdf`));
    });

    it('searches the whole set by name, by page, for the owner’s own live files only', async () => {
      await many(70, {}, { name: 'invoice' });
      await many(5, {}, { name: 'Passport' });
      await many(3, { source: 'bot' }, { name: 'passport-made' });
      await many(4, { expiresAt: new Date(Date.now() - 1000) }, { name: 'passport-old' });
      await many(2, {}, { name: 'passport-omar', owner: people.omar.id });
      const found = await page('section=sent&q=PASSPORT');
      expect(found.body.total).toBe(5);
      expect(found.body.files.map((f) => f.name).sort()).toEqual(Array.from({ length: 5 }, (_, index) => `Passport-${index + 1}.pdf`));
      expect((await page('section=made&q=passport')).body.total).toBe(3);
      // The oldest of 70 is found though the first look never listed it
      const oldest = await page('section=sent&q=invoice-70');
      expect(oldest.body.files.map((f) => f.name)).toEqual(['invoice-70.pdf']);
      expect(oldest.body.nextCursor).toBeNull();
      // A search with many results goes on by cursor too
      const all = await walk('sent', '&q=invoice');
      expect(all.names).toHaveLength(70);
      expect(all.pages).toBe(2);
      expect((await page('section=sent&q=nothing-like-this')).body).toMatchObject({ files: [], total: 0, nextCursor: null });
    });

    it('takes odd searches in its stride: blank, very long, with wildcards, with a character the database cannot search', async () => {
      await many(3, {}, { name: 'report' });
      expect((await page('section=sent&q=')).body.total).toBe(3);
      expect((await page('section=sent&q=%20%20')).body.total).toBe(3);
      expect((await page(`section=sent&q=${'x'.repeat(SEARCH_MAX_LENGTH * 10)}`)).status).toBe(200);
      expect((await page('section=sent&q=%00')).status).toBe(200);
      expect((await page('section=sent&q=rep%00ort')).body.total).toBe(3);
      expect((await page('section=sent&q=%25')).status).toBe(200);
      expect((await page('section=sent&q=%27%3B%20drop%20table%20bot_files%3B--')).body.total).toBe(0);
      expect(await prisma.botFile.count({ where: { botId: brickId } })).toBe(3);
    });

    it('takes % _ and \\ in a search as the characters they are, never as wildcards', async () => {
      await many(1, {}, { name: 'a_b' });
      await many(1, {}, { name: 'axb' });
      await many(1, {}, { name: '100% done' });
      await many(1, {}, { name: '100 percent' });
      await many(1, {}, { name: 'back\\slash' });
      const names = async (q: string) => (await page(`section=sent&q=${encodeURIComponent(q)}`)).body.files.map((f) => f.name).sort();
      expect(await names('a_b')).toEqual(['a_b-1.pdf']);
      expect(await names('%')).toEqual(['100% done-1.pdf']);
      expect(await names('_')).toEqual(['a_b-1.pdf']);
      expect(await names('100%')).toEqual(['100% done-1.pdf']);
      expect(await names('\\')).toEqual(['back\\slash-1.pdf']);
      expect(await names('a%b')).toEqual([]);
      expect((await page('section=sent&q=%25')).body.total).toBe(1);
    });

    it('refuses a list it does not have and a place in it that it never gave out', async () => {
      await many(60);
      expect((await page('section=artifacts')).status).toBe(400);
      expect((await page('section=sent&cursor=not-a-cursor!')).status).toBe(400);
      expect((await page(`section=sent&cursor=${Buffer.from('abc:def').toString('base64url')}`)).status).toBe(400);
      expect((await page(`section=sent&cursor=${Buffer.from('99999999999999999999:x').toString('base64url')}`)).status).toBe(400);
      expect((await page('section=sent&cursor=')).status).toBe(200);
      const cursor = (await read('sara')).body.sent.nextCursor as string;
      // A place in one Brick's list is only a place in time: it shows nothing of another Brick
      expect((await page(`section=sent&cursor=${cursor}`, 'sara', otherBrickId)).body.files).toEqual([]);
    });
  });
});
