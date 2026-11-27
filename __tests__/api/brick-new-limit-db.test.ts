/**
 * "New Bricks per hour" (default-brick design, quick create: DB-E9, DB-T5, DB-T13) against a real database: every way of making a
 * Brick counts together, the 31st in an hour is turned away kindly with the real time, a limit changed in settings changes it, and
 * a make tried again with the same key gives back the first Brick. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a
 * migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/brick-new-limit-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { saveServerLimits } from '@/lib/bot-limits';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { deleteBrick } from '@/lib/brick-delete';
import { makeBrick, makeBrickFromChat, makeBrickOnce } from '@/lib/brick-make';
import { BrickRequestKeyUsed, NewBricksLimit } from '@/lib/brick-new-limit';
import { POST as postBrick } from '@/app/api/bricks/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const session = getSessionUser as jest.Mock;
type Person = { id: string; email: string; uuid: string };
let sara: Person, omar: Person;
let sarasFirst = '';

const as = (user: Person) => session.mockResolvedValue({ id: user.id, email: user.email, name: 'x', isSuperAdmin: false });
const post = (body: unknown) => postBrick(new NextRequest('http://localhost/api/bricks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const limitTo = (newPerHour: number) => saveServerLimits({ bricks: { newPerHour } }, sara.id);
const hour = 60 * 60 * 1000;
const bricksOf = (person: Person) => prisma.bot.findMany({ where: { ownerId: person.id, roomId: null }, orderBy: { createdAt: 'asc' } });
const make = (person: Person, name: string) => makeBrick(person.id, { name });

run('New Bricks per hour, in a real database', () => {
  beforeAll(async () => {
    const person = async (name: string): Promise<Person> => {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name } });
      return { id: user.id, email: user.email!, uuid: user.uuid };
    };
    sara = await person('sara');
    omar = await person('omar');
    // Sara's own first Brick (the one everyone gets), through which she asks in chat
    sarasFirst = (await ensureDefaultBrick(sara.id)).brick!.id;
  });

  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    await prisma.bot.deleteMany({ where: { ownerId: { in: [sara.id, omar.id] } } });
    await prisma.defaultBrick.deleteMany({ where: { userId: { in: [sara.id, omar.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, omar.id] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'bot-limits' } });
    await prisma.bot.deleteMany({ where: { ownerId: { in: [sara.id, omar.id] }, id: { not: sarasFirst } } });
    await prisma.userPreference.deleteMany({ where: { userId: { in: [sara.id, omar.id] }, key: 'timeZone' } });
    as(sara);
  });

  it('lets a person make 30 new Bricks in an hour (the agreed default) and turns the 31st away, naming when they can make another', async () => {
    for (let n = 1; n <= 30; n++) await make(sara, `Brick ${n}`);
    // Sara's first Brick is not one of the 30: 30 made, plus it, and the 31st is the one refused
    expect(await bricksOf(sara)).toHaveLength(31);
    const first = (await prisma.bot.findMany({ where: { ownerId: sara.id, id: { not: sarasFirst } }, orderBy: { createdAt: 'asc' }, take: 1 }))[0];
    const refused = await make(sara, 'Brick 31').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NewBricksLimit);
    expect((refused as NewBricksLimit).limit).toBe(30);
    expect((refused as NewBricksLimit).retryAt.getTime()).toBe(first.createdAt.getTime() + hour);
    expect(await bricksOf(sara)).toHaveLength(31);
  });

  it('answers the person with 429, the real time in their own clock, and retryAt', async () => {
    await limitTo(2);
    await prisma.userPreference.create({ data: { userId: sara.id, key: 'timeZone', value: 'Asia/Kuwait' } });
    await make(sara, 'One');
    const second = await post({ name: 'Two' });
    expect(second.status).toBe(201);
    const response = await post({ name: 'Three' });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe('new_bricks_limit');
    expect(body.error).toMatch(/^You've made a lot of Bricks this hour\. Try again at \d{1,2}:\d{2} (AM|PM)\.$/);
    const oldest = (await prisma.bot.findMany({ where: { ownerId: sara.id, id: { not: sarasFirst } }, orderBy: { createdAt: 'asc' }, take: 1 }))[0];
    expect(body.retryAt).toBe(new Date(oldest.createdAt.getTime() + hour).toISOString());
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await bricksOf(sara)).toHaveLength(3);
  });

  it('counts every way of making a Brick together: New Brick and asking a Brick in chat', async () => {
    await limitTo(2);
    await make(sara, 'From the form');
    const chat = await makeBrickFromChat(sarasFirst, { userId: sara.uuid, name: 'From chat', description: 'x', chatInstructions: 'y' } as never);
    expect(chat).toMatchObject({ ok: true, made: true });
    const refused = await makeBrickFromChat(sarasFirst, { userId: sara.uuid, name: 'One too many', description: 'x', chatInstructions: 'y' } as never);
    expect(refused).toMatchObject({ ok: false, status: 429, code: 'new_bricks_limit' });
    if (!refused.ok && refused.status === 429) expect(refused.error).toMatch(/^You've made a lot of Bricks this hour\. Try again in \d+ minutes\.$/);
    expect(await bricksOf(sara)).toHaveLength(3);
  });

  it('keeps counting a Brick that was deleted, so make and delete cannot get round it', async () => {
    await limitTo(2);
    const one = await make(sara, 'One');
    await make(sara, 'Two');
    await deleteBrick(one.id, sara.id);
    expect(await make(sara, 'Three').catch((error: unknown) => error)).toBeInstanceOf(NewBricksLimit);
  });

  it('lets them make another once the oldest has been there an hour', async () => {
    await limitTo(2);
    const one = await make(sara, 'One');
    await make(sara, 'Two');
    expect(await make(sara, 'Three').catch((error: unknown) => error)).toBeInstanceOf(NewBricksLimit);
    await prisma.bot.update({ where: { id: one.id }, data: { createdAt: new Date(Date.now() - hour - 1000) } });
    expect((await make(sara, 'Three')).name).toBe('Three');
  });

  it('limits each person on their own', async () => {
    await limitTo(1);
    await make(sara, 'Sara one');
    expect(await make(sara, 'Sara two').catch((error: unknown) => error)).toBeInstanceOf(NewBricksLimit);
    expect((await make(omar, 'Omar one')).name).toBe('Omar one');
  });

  it('follows the limit when a super admin changes it', async () => {
    await limitTo(1);
    await make(sara, 'One');
    expect(await make(sara, 'Two').catch((error: unknown) => error)).toBeInstanceOf(NewBricksLimit);
    await limitTo(3);
    expect((await make(sara, 'Two')).name).toBe('Two');
  });

  it('holds when many are made at once: exactly the limit gets through', async () => {
    await limitTo(5);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => make(sara, `At once ${n}`)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected' && result.reason instanceof NewBricksLimit)).toHaveLength(7);
    expect(await prisma.bot.count({ where: { ownerId: sara.id, id: { not: sarasFirst } } })).toBe(5);
  });

  describe('a make tried again with the same request key (DB-T13)', () => {
    it('gives back the first Brick and makes no second, whether it comes one after the other or at once', async () => {
      const first = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      expect(first.created).toBe(true);
      const again = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      expect(again).toEqual({ brick: first.brick, created: false });
      const together = await Promise.all([1, 2, 3, 4].map(() => makeBrickOnce(sara.id, { name: 'Pink Brick' }, undefined, 'key-2')));
      expect(together.filter((one) => one.created)).toHaveLength(1);
      expect(new Set(together.map((one) => one.brick.id)).size).toBe(1);
      expect(await prisma.bot.count({ where: { ownerId: sara.id, id: { not: sarasFirst } } })).toBe(2);
    });

    it('is not counted twice, and is still answered when the person is at the limit', async () => {
      await limitTo(1);
      const first = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      const again = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      expect(again.brick.id).toBe(first.brick.id);
      expect(await makeBrickOnce(sara.id, { name: 'Other' }, undefined, 'key-2').catch((error: unknown) => error)).toBeInstanceOf(NewBricksLimit);
    });

    it('refuses a key that comes back for another Brick, or for one since deleted', async () => {
      const first = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      expect(await makeBrickOnce(sara.id, { name: 'Another name' }, undefined, 'key-1').catch((error: unknown) => error)).toBeInstanceOf(BrickRequestKeyUsed);
      await deleteBrick(first.brick.id, sara.id);
      expect(await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1').catch((error: unknown) => error)).toBeInstanceOf(BrickRequestKeyUsed);
    });

    it('still gives back the first Brick when the owner has renamed it since, and still refuses the key for another name', async () => {
      const first = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      await prisma.bot.update({ where: { id: first.brick.id }, data: { name: 'Renamed Brick' } });
      const again = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'key-1');
      expect(again).toMatchObject({ created: false, brick: { id: first.brick.id } });
      expect(await makeBrickOnce(sara.id, { name: 'Renamed Brick' }, undefined, 'key-1').catch((error: unknown) => error)).toBeInstanceOf(BrickRequestKeyUsed);
    });

    it('is the same key for the same person only', async () => {
      const mine = await makeBrickOnce(sara.id, { name: 'Teal Brick' }, undefined, 'shared-key');
      const theirs = await makeBrickOnce(omar.id, { name: 'Teal Brick' }, undefined, 'shared-key');
      expect(theirs.created).toBe(true);
      expect(theirs.brick.id).not.toBe(mine.brick.id);
    });
  });
});
