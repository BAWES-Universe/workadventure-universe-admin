/**
 * The file card, against a real database with the PRETEND provider and the files kept in memory: a finished job hands over the files it made, they wait
 * encrypted until the bot server has put them in the chat, and they are deleted when they reach it, when the Brick goes, and when Limits' days pass.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/computer-file-cards-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks } from '@/lib/brick-delete';
import { saveMeterSettings } from '@/lib/meter';
import { saveServerLimits } from '@/lib/bot-limits';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { finishJob, giveComputer, startJob, stopJobFor, sweepComputers } from '@/lib/computer';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';
import { PIECE_BYTES, readCard, setCardStoreForTests, type CardStore } from '@/lib/computer-file-cards';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-17T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const seconds = (n: number) => Math.floor(minutes(n).getTime() / 1000);
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;

/** What is on the pretend machine: path from home folder to its bytes and when it was made (seconds). */
const machineFiles = new Map<string, { data: Buffer; at: number }>();
/** What is kept in the bucket. */
const kept = new Map<string, Buffer>();
let removeFails = false;
const store: CardStore = {
  async put(key, sealed) {
    kept.set(key, sealed);
  },
  async get(key) {
    const found = kept.get(key);
    if (!found) throw new Error('missing');
    return found;
  },
  async remove(keys) {
    if (removeFails) throw new Error('the bucket did not answer');
    for (const key of keys) kept.delete(key);
  },
};

/** The pretend machine answers the list and the reads the way the real commands do. */
function machine(command: string) {
  if (command === 'universe-files') {
    const lines = [...machineFiles].sort((a, b) => b[1].at - a[1].at).map(([path, file]) => `${file.data.length}\t${file.at}\t${path}`);
    return { stdout: `${lines.join('\n')}\n` };
  }
  const named = /\nf='\.\/((?:[^']|'\\'')*)'\n/.exec(command);
  if (!named) return command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {};
  const file = machineFiles.get(named[1].replace(/'\\''/g, "'"));
  if (!file) return { exitCode: 4 };
  if (command.includes('stat -c')) return { stdout: `${file.data.length} ${file.at}\n` };
  const piece = /tail -c \+(\d+) -- "\$f" \| head -c (\d+)/.exec(command);
  if (!piece) return {};
  const from = Number(piece[1]) - 1;
  return { stdout: file.data.subarray(from, from + Number(piece[2])).toString('base64') };
}

async function person(name: string, chat: string | null = `@${name}-${tag}:chat.example`): Promise<{ id: string; brickId: string }> {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name, matrixChatId: chat } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  return { id: user.id, brickId: brick.id };
}

const setUp = () =>
  saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10 }, 'admin');

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down'] } } });
};

async function started(sara: { id: string; brickId: string }, title = 'Visa form', at: Date = NOW) {
  await giveComputer(sara.brickId, sara.id);
  const job = await startJob({ botId: sara.brickId, personId: sara.id, title }, at);
  if (!job.ok) throw new Error('no job');
  return job.job.id;
}

const made_ = (path: string, data: string | Buffer, atMinutes: number) => machineFiles.set(path, { data: Buffer.from(data), at: seconds(atMinutes) });
const mine = async (jobIds: string[], now: Date = minutes(20)) => (await reportsToTell(200, now)).filter((report) => jobIds.includes(report.jobId));

run('The files a finished computer job made reach the chat as cards, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
    process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
    setCardStoreForTests(store);
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    machineFiles.clear();
    kept.clear();
    removeFails = false;
    provider = new FakeComputerProvider();
    provider.execAnswer = machine;
    setComputerProviderForTests(provider);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    setCardStoreForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('hands over what the job made, and the message carries the cards: the bytes come back whole, and are deleted once told', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    const receipt = Buffer.from('%PDF-1.4 visa receipt'.repeat(40));
    const big = Buffer.alloc(PIECE_BYTES + 777, 9);
    made_('Documents/visa_receipt.pdf', receipt, 5);
    made_('Documents/photo.png', big, 6);
    made_('.hermes/state.db', 'internal', 6);
    made_('old/notes.txt', 'older', -600);
    await finishJob(id, 'done', minutes(9));
    const [done, ...rest] = await mine([id]);
    expect(rest).toEqual([]);
    expect(done.handed.map((card) => ({ name: card.name, bytes: card.bytes, mime: card.mime }))).toEqual([
      { name: 'photo.png', bytes: big.length, mime: 'image/png' },
      { name: 'visa_receipt.pdf', bytes: receipt.length, mime: 'application/pdf' },
    ]);
    // Cards are not named again, and nothing of Orbit's own goes to the bot server
    expect(done.files).toEqual([]);
    expect(JSON.stringify(done)).not.toContain('storage');
    expect(JSON.stringify(done)).not.toContain('Documents/');
    // What waits in the bucket is encrypted, and comes back byte for byte
    expect(kept.size).toBe(2);
    for (const sealed of kept.values()) expect(sealed.includes(Buffer.from('visa receipt'))).toBe(false);
    const first = await readCard(id, done.handed[1].id);
    expect(first?.data.equals(receipt)).toBe(true);
    expect(first?.name).toBe('visa_receipt.pdf');
    expect((await readCard(id, done.handed[0].id))?.data.equals(big)).toBe(true);
    // A file that is not this job's is not given
    expect(await readCard(randomUUID(), done.handed[0].id)).toBeNull();
    // Told: the copies are deleted at once, the record stays, and the message is not offered again
    expect(await keepReportTold(id, 'done')).toBe(true);
    expect(kept.size).toBe(0);
    expect(await mine([id])).toEqual([]);
    expect(await readCard(id, done.handed[0].id)).toBeNull();
    const rows = await prisma.computerJobFile.findMany({ where: { jobId: id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.storageKey === null && row.purgedAt !== null)).toBe(true);
  });

  it('keeps the message back until the ending is closed, which is after the files were handed over, and tells anyway when the server stopped in the middle', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'done', minutes(9));
    // As while the ending is happening: the job is done but its ending is not closed yet
    await prisma.computerJob.update({ where: { id }, data: { endClosedAt: null, endedAt: new Date(Date.now() - 1000) } });
    expect(await mine([id], new Date())).toEqual([]);
    // A server that stopped in the middle left it so: after a while the message goes out without cards
    expect(await mine([id], new Date(Date.now() + 60 * 60 * 1000))).toHaveLength(1);
  });

  it('has the cards on the job before the ending is closed', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
    expect(job.endClosedAt).not.toBeNull();
    expect(await prisma.computerJobFile.count({ where: { jobId: id, storageKey: { not: null } } })).toBe(1);
  });

  it('hands over no more files than Limits say and none bigger, and names the rest', async () => {
    const sara = await person('sara');
    await saveServerLimits({ bricks: { computerFiles: 2, computerFileMb: 1 } }, 'admin');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    made_('b.pdf', 'b', 6);
    made_('c.pdf', 'c', 7);
    made_('huge.zip', Buffer.alloc(1024 * 1024 + 1), 8);
    await finishJob(id, 'done', minutes(9));
    // The list a job end takes is on the Brick's computer by the time it is told
    const [done] = await mine([id]);
    expect(done.handed.map((card) => card.name)).toEqual(['c.pdf', 'b.pdf']);
    // What was not handed over is named (the list of the machine), never silently dropped
    expect(done.files).toEqual(['huge.zip', 'a.pdf']);
  });

  it('hands over none when Limits say 0', async () => {
    const sara = await person('sara');
    await saveServerLimits({ bricks: { computerFiles: 0 } }, 'admin');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed).toEqual([]);
    expect(kept.size).toBe(0);
    expect(done.files).toEqual(['a.pdf']);
  });

  it('never hands over a file twice, and a later job hands over only what it made', async () => {
    const sara = await person('sara');
    const first = await started(sara, 'First');
    made_('receipt.pdf', 'one', 3);
    await finishJob(first, 'done', minutes(5));
    expect((await mine([first]))[0].handed.map((card) => card.name)).toEqual(['receipt.pdf']);
    await keepReportTold(first, 'done');
    // The next job starts a moment later: the first job's file is still within the clock's give, and is not handed over again
    const second = await started(sara, 'Second', minutes(5.5));
    made_('summary.pdf', 'two', 7);
    await finishJob(second, 'done', minutes(8));
    expect((await mine([second]))[0].handed.map((card) => card.name)).toEqual(['summary.pdf']);
  });

  it('never carries a file for a job that did not finish well, or one the person stopped', async () => {
    const sara = await person('sara');
    const failed = await started(sara, 'Failed');
    made_('half.pdf', 'half', 3);
    await finishJob(failed, 'failed', minutes(5), 'The site said no');
    expect((await mine([failed]))[0].handed).toEqual([]);
    const stopped = await started(sara, 'Stopped', minutes(6));
    made_('other.pdf', 'other', 7);
    await stopJobFor(sara.brickId, sara.id, minutes(8));
    expect(await mine([stopped])).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it('tells without cards when the computer cannot be read, and holds nothing back', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    provider.execAnswer = (command) => (command === 'universe-files' || command.includes('stat -c') ? { exitCode: 1 } : machine(command));
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed).toEqual([]);
    expect(kept.size).toBe(0);
    expect(await prisma.computerJobFile.count({ where: { jobId: id } })).toBe(0);
  });

  it('keeps no row for a file that could not be kept', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    const failing: CardStore = { ...store, put: async () => { throw new Error('the bucket did not answer'); } };
    setCardStoreForTests(failing);
    try {
      await finishJob(id, 'done', minutes(9));
    } finally {
      setCardStoreForTests(store);
    }
    expect((await mine([id]))[0].handed).toEqual([]);
    expect(await prisma.computerJobFile.count({ where: { jobId: id } })).toBe(0);
  });

  it('counts the time it took to hand the files over as the job’s time', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    const slow = provider.execAnswer;
    provider.execAnswer = async (command) => {
      if (command.includes('tail -c')) await new Promise((resolve) => setTimeout(resolve, 1500));
      return slow(command);
    };
    await finishJob(id, 'done', minutes(9));
    const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
    // 9 minutes of the job and the seconds the files took, which are on the books too
    expect(job.secondsRun).toBeGreaterThanOrEqual(9 * 60 + 1);
    expect(job.secondsRun).toBeLessThan(9 * 60 + 10);
    const event = await prisma.meterEvent.findUnique({ where: { eventId: `computer:${id}:time` } });
    expect(Number(event?.quantity)).toBe(job.secondsRun);
  });

  it('leaves a resting computer alone: it is never woken to hand files over', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
    const before = provider.commands.length;
    await finishJob(id, 'done', minutes(9));
    expect(provider.commands.slice(before).filter((one) => one.command === 'universe-files')).toEqual([]);
    expect((await mine([id]))[0].handed).toEqual([]);
  });

  it('does not rest the machine under the files being read, even when the sweep finds it idle; the job that reads them rests it after', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.execAnswer = async (command) => {
      if (command.includes('tail -c')) await gate;
      return machine(command);
    };
    const finishing = finishJob(id, 'done', minutes(9));
    // Wait until the files are being read
    for (let tries = 0; tries < 200 && !(await prisma.brickComputer.findUnique({ where: { botId: sara.brickId } }))?.filesClaimedAt; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).filesClaimedAt).not.toBeNull();
    // The machine looks idle to the sweep: nothing was written to its row for more than two minutes
    await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = now() - interval '10 minutes' WHERE "bot_id" = ${sara.brickId}`;
    await sweepComputers(new Date());
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
    expect(provider.calls.filter((call) => call.name === 'rest')).toEqual([]);
    release();
    await finishing;
    const after = await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } });
    expect(after.machine).toBe('resting');
    expect(after.filesClaimedAt).toBeNull();
    expect((await mine([id]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
  });

  it('rests a machine whose hand-over claim a stopped server left behind', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'stopped' as never, minutes(1)).catch(() => undefined);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { machine: 'working', filesClaimedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = now() - interval '10 minutes' WHERE "bot_id" = ${sara.brickId}`;
    await sweepComputers(new Date());
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
  });

  it('deletes what was kept when the Brick is removed for good, and keeps the Brick for the next sweep when it cannot', async () => {
    const omar = await person('omar');
    const id = await started(omar);
    made_('a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    expect(kept.size).toBe(1);
    await deleteBrick(omar.brickId, omar.id, NOW);
    const later = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);
    removeFails = true;
    expect(await removeGoneBricks(later, omar.id)).toEqual([]);
    expect(kept.size).toBe(1);
    expect(await prisma.bot.count({ where: { id: omar.brickId } })).toBe(1);
    removeFails = false;
    expect(await removeGoneBricks(later, omar.id)).toEqual([omar.brickId]);
    expect(kept.size).toBe(0);
    expect(await prisma.computerJobFile.count({ where: { botId: omar.brickId } })).toBe(0);
  });

  it('deletes what waited for a chat that never took it, when the days in Limits are up', async () => {
    const sara = await person('sara');
    await saveServerLimits({ bricks: { computerFileDays: 2 } }, 'admin');
    const id = await started(sara);
    made_('a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    expect(kept.size).toBe(1);
    await prisma.computerJobFile.updateMany({ where: { jobId: id }, data: { createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) } });
    await sweepComputers(new Date());
    expect(kept.size).toBe(1);
    await prisma.computerJobFile.updateMany({ where: { jobId: id }, data: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
    await sweepComputers(new Date());
    expect(kept.size).toBe(0);
    // The message that is still to be told then names the file instead of carrying a card that is gone
    expect((await mine([id], new Date()))[0].handed).toEqual([]);
  });
});
