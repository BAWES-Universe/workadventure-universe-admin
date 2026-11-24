/**
 * The park trigger and its repair migration (CodeRabbit on #1025, A15 and D12), against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-park-hold-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { giveComputer } from '@/lib/computer';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const people: string[] = [];
let made = 0;

async function owner(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  await giveComputer(brick.id, user.id);
  await prisma.brickComputer.upsert({ where: { botId: brick.id }, create: { botId: brick.id, machine: 'working', provider: 'fake', providerRef: `fake-${brick.id}` }, update: {} });
  return { id: user.id, brickId: brick.id };
}
const queued = (who: { id: string; brickId: string }, title: string) => prisma.computerJob.create({ data: { botId: who.brickId, personId: who.id, title, status: 'queued', queuedFor: 'turn' } });

/** The statements of a migration file, split on `;` outside of dollar-quoted function bodies. */
function statementsOf(sql: string): string[] {
  const parts = sql.split('$$');
  const out: string[] = [];
  let current = '';
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      current += `$$${part}$$`;
      return;
    }
    const pieces = part.split(';');
    pieces.forEach((piece, at) => {
      current += piece;
      if (at < pieces.length - 1) {
        out.push(current);
        current = '';
      }
    });
  });
  if (current.trim()) out.push(current);
  return out.map((one) => one.replace(/^(\s*--.*\n)+/g, '').trim()).filter((one) => one && !/^(--.*(\n|$))+$/.test(one));
}
const MIGRATION = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261123050000_computer_park_hold_repair/migration.sql'), 'utf8');
const applyRepair = async () => {
  for (const statement of statementsOf(MIGRATION)) await prisma.$executeRawUnsafe(statement);
};

run('the park trigger and its repair migration (A15, D12), in a real database', () => {
  afterAll(async () => {
    await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  });
  beforeEach(async () => {
    await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitingOn = async (needle: string) => {
    for (let at = 0; at < 150; at++) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ${`%${needle}%`}`;
      if (rows[0].n > 0) return true;
      await sleep(20);
    }
    return false;
  };

  it('A15: a start waits for a pause that wrote the park pointer and has not committed, then reads the COMMITTED pointer and is skipped; with no pointer, or the pointer its own, it starts', async () => {
    const sara = await owner('a15');
    const paused = await queued(sara, 'paused one');
    const other = await queued(sara, 'other');
    let commit: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let written: () => void = () => undefined;
    const pointerWritten = new Promise<void>((resolve) => (written = resolve));
    const pause = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "brick_computers" SET "park_pending_job_id" = ${paused.id} WHERE "bot_id" = ${sara.brickId}`;
        written();
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    // A pause that fails is reported where the test waits for the pointer and where it joins the pause, never as an unhandled rejection
    pause.catch(() => undefined);
    let start: Promise<number> = Promise.resolve(-1);
    try {
      // The checkpoint is raced against the pause itself: a pause that fails (or ends) before it wrote the pointer rejects the wait at once, with its own error, and the test goes to its cleanup
      await Promise.race([pointerWritten, pause.then(() => { throw new Error('The pause ended before it wrote the park pointer'); })]);
      start = (async () => prisma.$executeRaw`UPDATE "computer_jobs" SET "status" = 'running' WHERE "id" = ${other.id}`)();
      // The start is waiting on the Brick's row (the pause's uncommitted write), not reading the old empty pointer
      expect(await waitingOn('computer_jobs')).toBe(true);
      commit();
      await pause;
      expect(await start).toBe(0);
    } finally {
      commit();
      await Promise.allSettled([pause, start]);
    }
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('queued');
    // The paused job's own resume passes (its id is the pointer's)
    expect(await prisma.$executeRaw`UPDATE "computer_jobs" SET "status" = 'running' WHERE "id" = ${paused.id}`).toBe(1);
    // CONTROL: with the pointer cleared (and the one writer gone) a start passes
    await prisma.computerJob.update({ where: { id: paused.id }, data: { status: 'stopped', endedBy: 'person', endedAt: new Date() } });
    await prisma.$executeRaw`UPDATE "brick_computers" SET "park_pending_job_id" = NULL WHERE "bot_id" = ${sara.brickId}`;
    expect(await prisma.$executeRaw`UPDATE "computer_jobs" SET "status" = 'running' WHERE "id" = ${other.id}`).toBe(1);
  });

  it('D12: the repair migration restores a database that recorded an earlier body (columns and triggers missing), and runs again on a complete one without changing anything', async () => {
    const triggers = async () => (await prisma.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE tgname IN ('computer_jobs_hold_pause', 'computer_jobs_hold_park') AND NOT tgisinternal ORDER BY tgname`).map((row) => row.tgname);
    const columns = async () => (await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE (table_name = 'brick_computers' AND column_name = 'park_pending_wipe') OR (table_name = 'computer_job_pauses' AND column_name = 'sign_ins_kept') ORDER BY column_name`).map((row) => row.column_name);
    try {
      // A database that ran an earlier body of the migration: no wipe flag, no kept flag, no triggers
      await prisma.$executeRawUnsafe('DROP TRIGGER "computer_jobs_hold_pause" ON "computer_jobs"');
      await prisma.$executeRawUnsafe('DROP TRIGGER "computer_jobs_hold_park" ON "computer_jobs"');
      await prisma.$executeRawUnsafe('ALTER TABLE "brick_computers" DROP COLUMN "park_pending_wipe"');
      await prisma.$executeRawUnsafe('ALTER TABLE "computer_job_pauses" DROP COLUMN "sign_ins_kept"');
      expect(await triggers()).toEqual([]);
      expect(await columns()).toEqual([]);
      await applyRepair();
      expect(await triggers()).toEqual(['computer_jobs_hold_park', 'computer_jobs_hold_pause']);
      expect(await columns()).toEqual(['park_pending_wipe', 'sign_ins_kept']);
      // Run again on the complete schema: no error, the same schema
      await applyRepair();
      expect(await triggers()).toEqual(['computer_jobs_hold_park', 'computer_jobs_hold_pause']);
      expect(await columns()).toEqual(['park_pending_wipe', 'sign_ins_kept']);
    } finally {
      // Whatever the test left half done is finished, so the other suites find the schema whole
      await applyRepair();
    }
    // And a paused job is still held by the restored trigger
    const sara = await owner('d12');
    const job = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'paused', status: 'queued', queuedFor: 'paused', pausedWhy: 'person', pausedAt: new Date() } });
    expect(await prisma.$executeRaw`UPDATE "computer_jobs" SET "status" = 'running' WHERE "id" = ${job.id}`).toBe(0);
  });
});
