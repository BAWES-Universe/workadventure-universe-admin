/**
 * A Brick moved to another key while its images are on someone else's key (#709): the images go back to the default, and it is done on the
 * transaction's own connection. The database pool here holds ONE connection, so a call that takes a second one while the transaction holds the
 * first would wait for it until the transaction ran out of time, and the save would fail. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL
 * to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client');
  const { PrismaPg } = jest.requireActual('@prisma/adapter-pg');
  const { Pool } = jest.requireActual('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool), log: ['error'] }) };
});
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
// The checks before the save are not what is tested here
jest.mock('@/lib/ai-provider-ref', () => ({ checkAiProviderRef: jest.fn(async () => null), checkBotModel: jest.fn(async () => null) }));
jest.mock('@/lib/notices', () => ({ ...jest.requireActual('@/lib/notices'), clearBotRunsOnNotices: jest.fn(async () => undefined) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { PATCH as changeBrick } from '@/app/api/bricks/[id]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);

run('moving a Brick to another key, on a pool of one connection', () => {
  jest.setTimeout(30_000);

  it('takes its images off someone else’s key inside the save, without a second connection', async () => {
    const sara = await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'Sara' } });
    const brick = await createBrick({ ownerId: sara.id, name: 'Brick' });
    await prisma.bot.update({ where: { id: brick.id }, data: { behaviorConfig: { vision: { choice: 'another', keyId: `omar-key-${tag}`, model: 'some-vision-model' }, walkSpeed: 2 } } });
    (getSessionUser as jest.Mock).mockResolvedValue({ id: sara.id, email: sara.email });
    const request = new NextRequest(`http://localhost/api/bricks/${brick.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aiProviderRef: `key-${tag}` }) });
    const response = await changeBrick(request, { params: Promise.resolve({ id: brick.id }) });
    expect(response.status).toBe(200);
    const saved = await prisma.bot.findUniqueOrThrow({ where: { id: brick.id }, select: { aiProviderRef: true, behaviorConfig: true } });
    expect(saved.aiProviderRef).toBe(`key-${tag}`);
    expect(saved.behaviorConfig).toEqual({ walkSpeed: 2 });
  });
});
