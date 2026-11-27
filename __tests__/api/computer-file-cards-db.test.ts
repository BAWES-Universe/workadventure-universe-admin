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
jest.mock('@/lib/computer-token', () => {
  const actual = jest.requireActual('@/lib/computer-token');
  return { ...actual, revokeJobTokens: jest.fn(actual.revokeJobTokens) };
});

import { prisma } from '@/lib/db';
import { revokeJobTokens } from '@/lib/computer-token';
import { costOfSeconds } from '@/lib/computer-values';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { saveMeterSettings } from '@/lib/meter';
import { saveServerLimits } from '@/lib/bot-limits';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { isFenceCheckCommand } from '@/lib/computer-fence-script';
import { proposeRule } from '@/lib/spend-rules';
import { finishJob, giveComputer, setHandOverClaimWaitForTests, startJob, stopJobFor, sweepComputers } from '@/lib/computer';
import { keepReportTold, reportsToTell } from '@/lib/computer-report';
import { deleteOwnResult, deleteResult, DELETED_BRICK_LABEL, markFileDelivered, orphanResultsOf, orphanResultsPage, PIECE_BYTES, readCard, readOwnResult, readResult, resultsOf } from '@/lib/computer-file-cards';
import { setOutputStoreForTests, type OutputStore } from '@/lib/workbench/store';
import { saveCodeJobLimits } from '@/lib/workbench/state';
import { resultsOfSource } from '@/lib/owned-results';
import { listBrickFiles } from '@/lib/brick-files';

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
/** What is kept in the bucket (the one store every result is kept in: sealing is that store's own, tested there). */
const kept = new Map<string, Uint8Array>();
let removeFails = false;
const store: OutputStore = {
  async put(key, bytes) {
    kept.set(key, bytes);
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
  // The list of one job's own output folder: plain files below it, no hidden part
  const folder = /\nd='((?:[^']|'\\'')*)'\n/.exec(command);
  if (folder && command.includes('find "$d"')) {
    const dir = folder[1];
    const lines = [...machineFiles]
      .filter(([path]) => path.startsWith(`${dir}/`) && path.slice(dir.length + 1).split('/').every((part) => !part.startsWith('.')))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([path, file]) => `${file.data.length}\t${file.at}\t${path}`);
    return { stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '' };
  }
  if (command === 'universe-files') {
    const lines = [...machineFiles].sort((a, b) => b[1].at - a[1].at).map(([path, file]) => `${file.data.length}\t${file.at}\t${path}`);
    return { stdout: `${lines.join('\n')}\n` };
  }
  const named = /\nf='\.\/((?:[^']|'\\'')*)'\n/.exec(command);
  if (!named) return isFenceCheckCommand(command) ? { stdout: 'remaining=0\n' } : {};
  const file = machineFiles.get(named[1].replace(/'\\''/g, "'"));
  if (!file) return { exitCode: 4 };
  const signature = `1 ${file.at} ${file.at}`;
  const piece = /tail -c \+(\d+) <&3 \| head -c (\d+)/.exec(command);
  if (piece) {
    const from = Number(piece[1]) - 1;
    return { stdout: `${signature}\n${file.data.subarray(from, from + Number(piece[2])).toString('base64')}` };
  }
  if (command.includes('stat -L -c %s')) return { stdout: `${file.data.length} ${file.at}|${signature}\n` };
  return {};
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
  // A person's results do not go with their jobs or Bricks: they are cleared by owner
  await prisma.computerJobFile.deleteMany({ where: { ownerId: { in: people } } });
  await prisma.ownedResult.deleteMany({ where: { ownerId: { in: people } } });
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
/** A file the job saved in its own output folder, which is the only place a job's result comes from. */
const out = (jobId: string, name: string, data: string | Buffer, atMinutes: number) => made_(`Outputs/${jobId}/${name}`, data, atMinutes);
const mine = async (jobIds: string[], now: Date = minutes(20)) => (await reportsToTell(200, now)).filter((report) => jobIds.includes(report.jobId));

run('The files a finished computer job made reach the chat as cards, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
    process.env.BOT_SERVICE_TOKEN ||= 'a-test-service-token';
    process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
    setOutputStoreForTests(store);
  });
  beforeEach(async () => {
    await saveCodeJobLimits({ maxKeptBytesPerPerson: 1_073_741_824 }, 'admin');
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    machineFiles.clear();
    kept.clear();
    removeFails = false;
    setHandOverClaimWaitForTests(null);
    provider = new FakeComputerProvider();
    provider.execAnswer = machine;
    setComputerProviderForTests(provider);
    await setUp();
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    setOutputStoreForTests(undefined);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  it('hands over what the job made, and the message carries the cards: the bytes come back whole, and stay the person’s result once told', async () => {
    const sara = await person('sara');
    // Before the job began: an old file, and a sensitive one touched a moment before the job (it must never be taken for the job's)
    made_('old/notes.txt', 'older', -600);
    made_('Documents/passport-scan.pdf', 'sensitive', -0.5);
    const id = await started(sara);
    const receipt = Buffer.from('%PDF-1.4 visa receipt'.repeat(40));
    const big = Buffer.alloc(PIECE_BYTES + 777, 9);
    out(id, 'visa_receipt.pdf', receipt, 5);
    out(id, 'photo.png', big, 6);
    out(id, '.scratch/tmp.bin', 'hidden part', 6);
    // Made while the job ran but NOT in its own folder (new, even changed in place): never handed over, however new. Another job's folder is never this job's
    made_('Documents/new-notes.txt', 'new notes', 7);
    made_('Documents/passport-scan.pdf', 'sensitive, then edited by the job', 8);
    made_('Outputs/some-other-job/theirs.pdf', 'theirs', 7);
    made_('.hermes/state.db', 'internal', 6);
    await finishJob(id, 'done', minutes(9));
    const [done, ...rest] = await mine([id]);
    expect(rest).toEqual([]);
    expect(done.handed.map((card) => ({ name: card.name, bytes: card.bytes, mime: card.mime }))).toEqual([
      { name: 'photo.png', bytes: big.length, mime: 'image/png' },
      { name: 'visa_receipt.pdf', bytes: receipt.length, mime: 'application/pdf' },
    ]);
    // Cards are not named again; what was saved elsewhere is only named (by path, never by time), and nothing of Orbit's own goes to the bot server
    expect(done.files.sort()).toEqual(['new-notes.txt', 'theirs.pdf']);
    expect(JSON.stringify(done)).not.toContain('storage');
    expect(JSON.stringify(done)).not.toContain('Documents/');
    // The files are kept as the person's own results, in the one store every result is kept in, and come back byte for byte
    expect(kept.size).toBe(2);
    expect((await resultsOfSource('computer_job', id)).map((row) => [row.name, row.ownerId, row.makerBotId, row.access])).toEqual([
      ['photo.png', sara.id, sara.brickId, 'owner'],
      ['visa_receipt.pdf', sara.id, sara.brickId, 'owner'],
    ]);
    const first = await readCard(id, done.handed[1].id);
    expect(first?.data.equals(receipt)).toBe(true);
    expect(first?.name).toBe('visa_receipt.pdf');
    expect((await readCard(id, done.handed[0].id))?.data.equals(big)).toBe(true);
    // A file that is not this job's is not given
    expect(await readCard(randomUUID(), done.handed[0].id)).toBeNull();
    // Told: the message is not offered again. The files stay the person's results (a copy in the chat is not the only copy), until the chat took each
    expect(await keepReportTold(id, 'done')).toBe(true);
    expect(await mine([id])).toEqual([]);
    expect(kept.size).toBe(2);
    expect((await readCard(id, done.handed[0].id))?.data.equals(big)).toBe(true);
    const rows = await prisma.computerJobFile.findMany({ where: { jobId: id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.resultId !== null && row.deliveredAt === null)).toBe(true);
    // Only the job's own folder is the job's: the sensitive file (touched before, edited during), the old one, a new one elsewhere and another job's folder never were
    expect(rows.map((row) => row.path).sort()).toEqual([`Outputs/${id}/photo.png`, `Outputs/${id}/visa_receipt.pdf`]);
    // Each is an owned record: whose it is, which job and Brick made it, and what the job was called
    expect(rows.every((row) => row.ownerId === sara.id && row.botId === sara.brickId && row.makerName === "sara's Brick" && row.jobTitle === 'Visa form')).toBe(true);
  });

  it('marks a file delivered when the chat took it, and a restart never offers it again', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    out(id, 'b.pdf', 'b', 6);
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed.map((card) => card.name)).toEqual(['b.pdf', 'a.pdf']);
    // The chat took the first one before the server stopped; the report was not confirmed
    expect(await markFileDelivered(id, done.handed[0].id)).toBe(true);
    expect(await markFileDelivered(id, done.handed[0].id)).toBe(true);
    expect(await markFileDelivered(randomUUID(), done.handed[1].id)).toBe(false);
    const [again] = await mine([id]);
    expect(again.handed.map((card) => card.name)).toEqual(['a.pdf']);
  });

  it('keeps a person’s results in Files whether or not the chat took them, and says which', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'taken.pdf', 'a', 5);
    out(id, 'refused.pdf', 'b', 6);
    out(id, 'later.pdf', 'c', 7);
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    const idOf = (name: string) => done.handed.find((card) => card.name === name)!.id;
    // Before anything is said, all are waiting
    expect((await resultsOf(sara.brickId, sara.id)).map((one) => one.delivery)).toEqual(['waiting', 'waiting', 'waiting']);
    await markFileDelivered(id, idOf('taken.pdf'));
    // The message went; one file the chat refused for good stays undelivered, and the report is told
    await keepReportTold(id, 'done');
    const results = await resultsOf(sara.brickId, sara.id);
    const state = Object.fromEntries(results.map((one) => [one.name, one.delivery]));
    expect(state).toEqual({ 'taken.pdf': 'delivered', 'refused.pdf': 'not_delivered', 'later.pdf': 'not_delivered' });
    expect(results[0].jobTitle).toBe('Visa form');
    // They are in the Files view, owner only, and open whole
    const view = await listBrickFiles(sara.brickId, sara.id, { text: 2_000_000, findable: 0, guestDays: 1 });
    expect(view.results.map((one) => one.name).sort()).toEqual(['later.pdf', 'refused.pdf', 'taken.pdf']);
    expect((await readResult(sara.brickId, sara.id, idOf('refused.pdf')))?.data.toString()).toBe('b');
    // Someone else's Files never has them
    const mia = await person('mia');
    expect((await listBrickFiles(mia.brickId, mia.id, { text: 2_000_000, findable: 0, guestDays: 1 })).results).toEqual([]);
    expect(await readResult(sara.brickId, mia.id, idOf('refused.pdf'))).toBeNull();
    expect(await deleteResult(sara.brickId, mia.id, idOf('refused.pdf'))).toBe(false);
    // The owner deletes one: the copy goes
    expect(await deleteResult(sara.brickId, sara.id, idOf('refused.pdf'))).toBe(true);
    expect(await readResult(sara.brickId, sara.id, idOf('refused.pdf'))).toBeNull();
    expect((await resultsOf(sara.brickId, sara.id)).map((one) => one.name).sort()).toEqual(['later.pdf', 'taken.pdf']);
  });

  it('keeps the result when the report can never be delivered, and never calls it told', async () => {
    const sara = await person('sara', null);
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.matrixUserId).toBeNull();
    // No chat to be told in: the bot server says so for good. It is not told, not offered again, and the file is still the person's
    expect(await keepReportTold(id, 'done', null, { delivered: false, why: 'no_chat' })).toBe(true);
    expect(await mine([id])).toEqual([]);
    const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
    expect(job.endToldAt).toBeNull();
    expect(job.endUndeliverableAt).not.toBeNull();
    expect(job.endUndeliverableWhy).toBe('no_chat');
    expect(kept.size).toBe(1);
    expect((await resultsOf(sara.brickId, sara.id))[0]).toMatchObject({ name: 'a.pdf', delivery: 'not_delivered' });
    // Saying it twice, or saying "told" after, changes nothing
    expect(await keepReportTold(id, 'done', null, { delivered: false, why: 'no_chat' })).toBe(true);
    expect(await keepReportTold(id, 'done')).toBe(true);
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id } })).endToldAt).toBeNull();
  });

  it('keeps results past a restart of everything: they are in the bucket and the rows, not in anyone’s memory', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    await keepReportTold(id, 'done', null, { delivered: false, why: 'refused' });
    // No expiry: a result is the person's own until they delete it, however long ago it was made and however many sweeps have run
    await prisma.computerJobFile.updateMany({ where: { jobId: id }, data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) } });
    await prisma.ownedResult.updateMany({ where: { sourceKind: 'computer_job', sourceId: id }, data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) } });
    await sweepComputers(new Date());
    expect(kept.size).toBe(1);
    expect((await resultsOf(sara.brickId, sara.id)).map((one) => one.name)).toEqual(['a.pdf']);
    // Only the owner deleting it removes it
    const [only] = await resultsOf(sara.brickId, sara.id);
    expect(await deleteResult(sara.brickId, sara.id, only.id)).toBe(true);
    expect(kept.size).toBe(0);
  });

  it('hands over the job’s own folder even when the list from before the job could not be taken, and names nothing else (nothing outside the folder can be proved)', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    made_('elsewhere.pdf', 'e', 5);
    // The list from before could not be taken
    await prisma.$executeRaw`UPDATE computer_jobs SET start_files = NULL WHERE id = ${id}`;
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed.map((card) => card.name)).toEqual(['a.pdf']);
    expect(done.files).toEqual([]);
  });

  it('remembers the conversation a job began in, and the report carries it', async () => {
    const sara = await person('sara');
    await giveComputer(sara.brickId, sara.id);
    const job = await startJob({ botId: sara.brickId, personId: sara.id, title: 'From a chat', origin: { kind: 'dm', ref: '!room-abc:chat.example' } }, NOW);
    if (!job.ok) throw new Error('no job');
    await finishJob(job.job.id, 'done', minutes(5));
    expect((await mine([job.job.id]))[0].origin).toEqual({ kind: 'dm', ref: '!room-abc:chat.example' });
    // A job that began without one (a goal's run) has none: it goes to the person's own direct chat
    const plain = await startJob({ botId: sara.brickId, personId: sara.id, title: 'No chat' }, minutes(6));
    if (!plain.ok) throw new Error('no job');
    await finishJob(plain.job.id, 'done', minutes(8));
    expect((await mine([plain.job.id]))[0].origin).toBeNull();
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

  it('does not tell a half-closed ending while the files could still be being handed over', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'done', minutes(9));
    await prisma.computerJob.update({ where: { id }, data: { endClosedAt: null, endedAt: minutes(9) } });
    // The 5 minutes the rest of the ending takes, plus the longest hand-over (budget and the command it may still wait on), have not passed
    expect(await mine([id], minutes(9 + 5 + 3))).toEqual([]);
    expect(await mine([id], minutes(9 + 5 + 4 + 1))).toHaveLength(1);
  });

  it('hands over the job’s own folder, and never gives a job the folder of another: a reader asked for while the writer works waits its turn and starts when the writer ends', async () => {
    const sara = await person('sara');
    const writer = await started(sara, 'Writer');
    const reader = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Reader', writes: false }, minutes(1));
    if (!reader.ok) throw new Error('no read-only job');
    // A job that may sign in has the machine alone: the reader waits its turn (round 8, F)
    expect(await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.job.id } })).toMatchObject({ status: 'queued', queuedFor: 'turn' });
    // The writer saves a file in its folder; a file lands in the reader's folder too (a job that only looks never hands anything over)
    out(writer, 'invoice.pdf', 'inv', 4);
    out(reader.job.id, 'stray.pdf', 'stray', 4);
    // The writer ends: its own folder is handed over, and not the reader's, and the reader then starts
    await finishJob(writer, 'done', minutes(8));
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id: reader.job.id } })).status).toBe('running');
    await finishJob(reader.job.id, 'done', minutes(9));
    expect(await prisma.computerJobFile.count({ where: { jobId: reader.job.id } })).toBe(0);
    const [done] = await mine([writer]);
    expect(done.handed.map((card) => card.name)).toEqual(['invoice.pdf']);
    expect((await mine([reader.job.id]))[0].handed).toEqual([]);
    expect(await prisma.computerJobFile.count({ where: { path: { contains: reader.job.id } } })).toBe(0);
  });

  it('has the cards on the job before the ending is closed', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
    expect(job.endClosedAt).not.toBeNull();
    expect(await prisma.computerJobFile.count({ where: { jobId: id, resultId: { not: null } } })).toBe(1);
  });

  it('hands over no more files than Limits say and none bigger, and names the rest', async () => {
    const sara = await person('sara');
    await saveServerLimits({ bricks: { computerFiles: 2, computerFileMb: 1 } }, 'admin');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    out(id, 'b.pdf', 'b', 6);
    out(id, 'c.pdf', 'c', 7);
    out(id, 'huge.zip', Buffer.alloc(1024 * 1024 + 1), 8);
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
    out(id, 'a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed).toEqual([]);
    expect(kept.size).toBe(0);
    expect(done.files).toEqual(['a.pdf']);
  });

  it('keeps a result inside what one person may keep (the same Limit a code job’s files count against), and names what did not fit', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'aaaa', 5);
    out(id, 'b.pdf', 'bbbbbbbbbbbb', 6);
    // 6 bytes may be kept: the newest (12 bytes) does not fit, the other (4) does
    await saveCodeJobLimits({ maxKeptBytesPerPerson: 6 }, 'admin');
    try {
      await finishJob(id, 'done', minutes(9));
    } finally {
      await saveCodeJobLimits({ maxKeptBytesPerPerson: 1_073_741_824 }, 'admin');
    }
    const [done] = await mine([id]);
    expect(done.handed.map((card) => card.name)).toEqual(['a.pdf']);
    // What did not fit stays on the computer and is named
    expect(done.files).toEqual(['b.pdf']);
    expect(kept.size).toBe(1);
  });

  it('never passes what one person may keep when two of their jobs hand over at the same moment: one fits, the other is named', async () => {
    const sara = await person('sara');
    const second = (await createBrick({ ownerId: sara.id, name: 'Second of Sara' })).id;
    const first = await started(sara, 'First');
    const other = await started({ id: sara.id, brickId: second }, 'Second');
    out(first, 'a.bin', Buffer.alloc(60, 1), 5);
    out(other, 'b.bin', Buffer.alloc(60, 2), 5);
    // Both pass a count taken before either keeps: only the step under the owner's lock holds the line
    await saveCodeJobLimits({ maxKeptBytesPerPerson: 100 }, 'admin');
    try {
      await Promise.all([finishJob(first, 'done', minutes(9)), finishJob(other, 'done', minutes(9))]);
    } finally {
      await saveCodeJobLimits({ maxKeptBytesPerPerson: 1_073_741_824 }, 'admin');
    }
    const handed = (await mine([first, other])).flatMap((report) => report.handed);
    expect(handed).toHaveLength(1);
    expect(kept.size).toBe(1);
    expect(await prisma.ownedResult.aggregate({ where: { ownerId: sara.id }, _sum: { sizeBytes: true } }).then((sum) => sum._sum.sizeBytes ?? 0)).toBeLessThanOrEqual(100);
  });

  it('keeps nothing when what one person may keep is not set', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    await saveCodeJobLimits({ maxKeptBytesPerPerson: null }, 'admin');
    try {
      await finishJob(id, 'done', minutes(9));
    } finally {
      await saveCodeJobLimits({ maxKeptBytesPerPerson: 1_073_741_824 }, 'admin');
    }
    expect((await mine([id]))[0].handed).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it('keeps two files of the same name from different subfolders of the job’s folder, both', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'march/report.pdf', 'march', 5);
    out(id, 'april/report.pdf', 'april', 6);
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed.map((card) => card.name).sort()).toEqual(['report (2).pdf', 'report.pdf']);
    const byName = new Map(await Promise.all(done.handed.map(async (card) => [card.name, (await readCard(id, card.id))?.data.toString()] as const)));
    expect([...byName.values()].sort()).toEqual(['april', 'march']);
  });

  it('does not name a file as left on the computer once it was handed over: not after the chat took it, not after the person deleted it', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    out(id, 'b.pdf', 'b', 6);
    await finishJob(id, 'done', minutes(9));
    const [first] = await mine([id]);
    expect(first.handed.map((card) => card.name)).toEqual(['b.pdf', 'a.pdf']);
    expect(first.files).toEqual([]);
    // The chat took one, the person deleted the other: the message is tried again, and neither is said to be left behind
    await markFileDelivered(id, first.handed[0].id);
    expect(await deleteResult(sara.brickId, sara.id, first.handed[1].id)).toBe(true);
    const [retry] = await mine([id]);
    expect(retry.handed).toEqual([]);
    expect(retry.files).toEqual([]);
  });

  it('never hands over a file twice, and a later job hands over only what it made', async () => {
    const sara = await person('sara');
    const first = await started(sara, 'First');
    out(first, 'receipt.pdf', 'one', 3);
    await finishJob(first, 'done', minutes(5));
    expect((await mine([first]))[0].handed.map((card) => card.name)).toEqual(['receipt.pdf']);
    await keepReportTold(first, 'done');
    // The next job starts a moment later: the first job's file is still within the clock's give, and is not handed over again
    const second = await started(sara, 'Second', minutes(5.5));
    out(second, 'summary.pdf', 'two', 7);
    await finishJob(second, 'done', minutes(8));
    expect((await mine([second]))[0].handed.map((card) => card.name)).toEqual(['summary.pdf']);
  });

  it('never carries a file for a job that did not finish well, or one the person stopped', async () => {
    const sara = await person('sara');
    const failed = await started(sara, 'Failed');
    out(failed, 'half.pdf', 'half', 3);
    await finishJob(failed, 'failed', minutes(5), 'The site said no');
    expect((await mine([failed]))[0].handed).toEqual([]);
    const stopped = await started(sara, 'Stopped', minutes(6));
    out(stopped, 'other.pdf', 'other', 7);
    await stopJobFor(sara.brickId, sara.id, minutes(8));
    expect(await mine([stopped])).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it('tells without cards when the computer cannot be read, and holds nothing back', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    provider.execAnswer = (command) => (command === 'universe-files' || command.includes('find "$d"') || command.includes('stat -L -c %s') ? { exitCode: 1 } : machine(command));
    await finishJob(id, 'done', minutes(9));
    const [done] = await mine([id]);
    expect(done.handed).toEqual([]);
    expect(kept.size).toBe(0);
    expect(await prisma.computerJobFile.count({ where: { jobId: id } })).toBe(0);
  });

  it('keeps no row for a file that could not be kept', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    setOutputStoreForTests({ ...store, put: async () => { throw new Error('the bucket did not answer'); } });
    try {
      await finishJob(id, 'done', minutes(9));
    } finally {
      setOutputStoreForTests(store);
    }
    expect((await mine([id]))[0].handed).toEqual([]);
    expect(await prisma.computerJobFile.count({ where: { jobId: id } })).toBe(0);
  });

  it('counts the time it took to hand the files over as the job’s time', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
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
    out(id, 'a.pdf', 'a', 5);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { machine: 'stopped' } });
    const before = provider.commands.length;
    await finishJob(id, 'done', minutes(9));
    expect(provider.commands.slice(before).filter((one) => one.command.includes('find "$d"'))).toEqual([]);
    expect((await mine([id]))[0].handed).toEqual([]);
  });

  it('does not rest the machine under the files being read, even when the sweep finds it idle; the job that reads them rests it after', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
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
    await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = (now() AT TIME ZONE 'UTC') - interval '10 minutes' WHERE "bot_id" = ${sara.brickId}`;
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

  it('leaves another hand-over’s claim on the machine alone: when it is never let go, a second job hands over nothing after its wait and never lets go of it', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    setHandOverClaimWaitForTests(700);
    // Another hand-over is reading files on this machine right now, and does not finish within the wait
    const theirs = new Date();
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: theirs } });
    const began = Date.now();
    await finishJob(id, 'done', minutes(9));
    // It waited for the other one before giving up
    expect(Date.now() - began).toBeGreaterThanOrEqual(600);
    const [done] = await mine([id]);
    expect(done.handed).toEqual([]);
    // What it made is only named, and the other claim is still there, untouched
    expect(done.files).toEqual(['a.pdf']);
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).filesClaimedAt?.getTime()).toBe(theirs.getTime());
  });

  it('waits for another hand-over to finish instead of giving its files up: they are handed over once the machine is let go of', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    setHandOverClaimWaitForTests(10_000);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
    // The other hand-over finishes a moment later and lets go
    setTimeout(() => prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } }).then(() => undefined), 800);
    await finishJob(id, 'done', minutes(9));
    expect((await mine([id]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).filesClaimedAt).toBeNull();
  });

  it('keeps waiting for a hand-over that runs a minute and a half: the second job still gets its files once the first lets go', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    // The real default wait; time is moved by hand so the test does not take a minute and a half
    jest.useFakeTimers({ advanceTimers: true, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'performance', 'hrtime'] });
    const turn = () => new Promise<void>((resolve) => jest.requireActual('node:timers').setImmediate(resolve));
    const realPause = (ms: number) => new Promise<void>((resolve) => jest.requireActual('node:timers').setTimeout(resolve, ms));
    try {
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
      const finished = finishJob(id, 'done', minutes(9));
      // Wait (in real time) until the second job is waiting for the machine
      for (let i = 0; i < 500 && jest.getTimerCount() === 0; i++) await turn();
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      // The first hand-over holds the machine for 90 seconds: the second job keeps waiting through them
      for (let waited = 0; waited < 90_000; waited += 500) {
        jest.advanceTimersByTime(500);
        await realPause(2);
      }
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
      for (let i = 0; i < 40; i++) {
        jest.advanceTimersByTime(500);
        await realPause(5);
      }
      await finished;
    } finally {
      jest.useRealTimers();
    }
    expect((await mine([id]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
  });

  it('keeps waiting while other hand-overs take the machine one after the other: a third job is not given up when its first four minutes pass', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    jest.useFakeTimers({ advanceTimers: true, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'performance', 'hrtime'] });
    const turn = () => new Promise<void>((resolve) => jest.requireActual('node:timers').setImmediate(resolve));
    const realPause = (ms: number) => new Promise<void>((resolve) => jest.requireActual('node:timers').setTimeout(resolve, ms));
    const ahead = async (milliseconds: number, pause: number) => {
      for (let waited = 0; waited < milliseconds; waited += 500) {
        jest.advanceTimersByTime(500);
        await realPause(pause);
      }
    };
    try {
      // The first hand-over holds the machine...
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
      const finished = finishJob(id, 'done', minutes(9));
      for (let i = 0; i < 500 && jest.getTimerCount() === 0; i++) await turn();
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      await ahead(230_000, 2);
      // ...and the second takes it just before the job's own four minutes are up, and holds it as long
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
      await ahead(230_000, 2);
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
      await ahead(20_000, 5);
      await finished;
    } finally {
      jest.useRealTimers();
    }
    expect((await mine([id]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
  });

  it('does not give up on a claim that was taken just before the wait ran out: the deadline is applied after the claim is read', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    setHandOverClaimWaitForTests(300);
    const realPause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    // One hand-over holds the machine...
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
    const finished = finishJob(id, 'done', minutes(9));
    await realPause(150);
    // ...and another takes it just before the 300 ms of waiting run out; the waiter next looks only after the deadline has passed
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
    await realPause(300);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
    await finished;
    expect((await mine([id]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
  });

  it('does not rest the machine under a job that finished while another hand-over was running: the first lets go, and the second still hands its files over', async () => {
    const sara = await person('sara');
    const first = await started(sara, 'First');
    out(first, 'a.pdf', 'a', 5);
    // The first job's hand-over is held up on the machine until the test lets it go
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const before = provider.execAnswer;
    provider.execAnswer = async (command) => {
      if (command.includes(`Outputs/${first}`)) await gate;
      return before(command);
    };
    const firstEnds = finishJob(first, 'done', minutes(9));
    // Wait (in real time) until that hand-over holds the machine
    for (let i = 0; i < 200 && !(await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).filesClaimedAt; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    // A second writer starts on the machine (the first is already done) and finishes while the first one still holds it
    const second = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, minutes(10));
    if (!second.ok) throw new Error('no second job');
    expect(second.job.status).toBe('running');
    out(second.job.id, 'b.pdf', 'b', 11);
    const secondEnds = finishJob(second.job.id, 'done', minutes(12));
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    await Promise.all([firstEnds, secondEnds]);
    expect((await mine([first]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
    // The first one's close-out did not rest the machine before the second read its files
    expect((await mine([second.job.id]))[0].handed.map((card) => card.name)).toEqual(['b.pdf']);
  });

  it('does not rest the machine in the gap between two hand-overs under a job that has waited for longer than a hand-over can last, and rests it once that job stopped beating', async () => {
    const sara = await person('sara');
    const first = await started(sara, 'First');
    // A second writer finished long before and is still in line for its files: nobody holds the machine at this moment (the gap), but it beats
    const second = await prisma.computerJob.create({ data: { botId: sara.brickId, personId: sara.id, title: 'Second', status: 'done', writes: true, startedAt: minutes(-1), endedAt: minutes(0), handOverAliveAt: new Date() } });
    await finishJob(first, 'done', minutes(9));
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('working');
    expect(provider.calls.filter((call) => call.name === 'rest')).toEqual([]);
    // The same job after its server stopped (no beat for longer than a beat lasts) is given up: the machine is rested by the next close-out
    await prisma.computerJob.update({ where: { id: second.id }, data: { handOverAliveAt: minutes(0) } });
    const third = await started(sara, 'Third', minutes(10));
    await finishJob(third, 'done', minutes(11));
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
  });

  it('beats while a job waits for its turn and stops when it is over, whichever way it ended', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    setHandOverClaimWaitForTests(300);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
    const finished = finishJob(id, 'done', minutes(9));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id } })).handOverAliveAt).not.toBeNull();
    await finished;
    // Given up after the wait: no beat is left saying it still waits
    expect((await prisma.computerJob.findUniqueOrThrow({ where: { id } })).handOverAliveAt).toBeNull();
  });

  it('does not wait for a machine that is not working any more: nothing is handed over and nothing is held up', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    setHandOverClaimWaitForTests(10_000);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { machine: 'stopped', filesClaimedAt: new Date() } });
    const began = Date.now();
    await finishJob(id, 'done', minutes(9));
    expect(Date.now() - began).toBeLessThan(5000);
    expect((await mine([id]))[0].handed).toEqual([]);
  });

  it('counts the time the machine was looked at as the job’s time even when no file came of it', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    // Nothing was made, and the machine is slow to answer the list
    const slow = provider.execAnswer;
    provider.execAnswer = async (command) => {
      if (command.includes('find "$d"')) await new Promise((resolve) => setTimeout(resolve, 1600));
      return slow(command);
    };
    await finishJob(id, 'done', minutes(9));
    const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
    expect(job.secondsRun).toBeGreaterThanOrEqual(9 * 60 + 1);
    expect(job.secondsRun).toBeLessThan(9 * 60 + 10);
    const event = await prisma.meterEvent.findUnique({ where: { eventId: `computer:${id}:time` } });
    expect(Number(event?.quantity)).toBe(job.secondsRun);
  });

  it('does not let the sweep write a job’s time while a hand-over holds its machine: it is written once the claim is gone', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'done', minutes(9));
    // The books have nothing for it (the write at the end did not happen), and a hand-over is adding to the job's time right now
    await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${id}:time` } });
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
    await sweepComputers(new Date());
    expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(0);
    // A claim long past (a stopped server left it) does not hold the books back
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await sweepComputers(new Date());
    expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(1);
  });

  it('does not let the sweep write the time of a job that still beats as waiting for its turn, even in a gap with no claim on the machine', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'done', minutes(9));
    await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${id}:time` } });
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
    await prisma.computerJob.update({ where: { id }, data: { handOverAliveAt: new Date() } });
    await sweepComputers(new Date());
    expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(0);
    await prisma.computerJob.update({ where: { id }, data: { handOverAliveAt: new Date(Date.now() - 60 * 1000) } });
    await sweepComputers(new Date());
    expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(1);
  });

  it('leaves a job that ended a minute and a half ago to its own hand-over: the sweep writes its time only after the longest hand-over could have been', async () => {
    const sara = await person('sara');
    const id = await started(sara, 'Visa form', new Date(Date.now() - 60 * 60 * 1000));
    await finishJob(id, 'done', new Date(Date.now() - 90 * 1000));
    await prisma.meterEvent.deleteMany({ where: { eventId: `computer:${id}:time` } });
    await sweepComputers(new Date());
    expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(0);
    await sweepComputers(new Date(Date.now() + 10 * 60 * 1000));
    expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(1);
  });

  it('lists a job a rule stopped while it waited in line once its grace has passed, and not before', async () => {
    const sara = await person('sara');
    await giveComputer(sara.brickId, sara.id);
    const job = await prisma.computerJob.create({
      data: { botId: sara.brickId, personId: sara.id, title: 'Never began', status: 'failed', endedBy: 'rule', endedAt: minutes(0), endClosedAt: minutes(0) },
    });
    // Not yet: the call that asked may be deleting it
    expect(await reportsToTell(200, new Date(minutes(0).getTime() + 10_000)).then((all) => all.filter((one) => one.jobId === job.id))).toEqual([]);
    expect((await reportsToTell(200, new Date(minutes(0).getTime() + 45_000))).filter((one) => one.jobId === job.id)).toHaveLength(1);
    // One that never began and was ended by anything else is never listed
    const other = await prisma.computerJob.create({
      data: { botId: sara.brickId, personId: sara.id, title: 'Never began either', status: 'failed', endedBy: 'person', endedAt: minutes(0), endClosedAt: minutes(0) },
    });
    expect((await reportsToTell(200, minutes(30))).filter((one) => one.jobId === other.id)).toEqual([]);
  });

  it('keeps the rule’s words when a rule stops a job while it waits in line, and the report says them', async () => {
    const sara = await person('sara');
    const first = await started(sara, 'First');
    const queued = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Second' }, NOW);
    if (!queued.ok) throw new Error('not queued');
    expect(queued.job.status).toBe('queued');
    // A rule is said while it waits, so its turn meets it
    await proposeRule({ botId: sara.brickId, speakerId: sara.id, sayingKey: 'cap-1', scope: 'bot', period: 'month', capMicros: 10_000 });
    await finishJob(first, 'done', minutes(9));
    const after = await prisma.computerJob.findUniqueOrThrow({ where: { id: queued.job.id } });
    expect(after).toMatchObject({ status: 'stopped', endedBy: 'rule' });
    expect(after.endNote).toContain('No more than $0.01 a month');
    const [report] = await mine([queued.job.id]);
    expect(report).toMatchObject({ kind: 'rule', why: expect.stringContaining('No more than $0.01 a month') });
  });

  it('takes over a hand-over claim that is long past, and lets go of its own', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await finishJob(id, 'done', minutes(9));
    expect((await mine([id]))[0].handed.map((card) => card.name)).toEqual(['a.pdf']);
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).filesClaimedAt).toBeNull();
  });

  it('rests a machine whose hand-over claim a stopped server left behind', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    await finishJob(id, 'stopped' as never, minutes(1)).catch(() => undefined);
    await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { machine: 'working', filesClaimedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await prisma.$executeRaw`UPDATE "brick_computers" SET "updated_at" = (now() AT TIME ZONE 'UTC') - interval '10 minutes' WHERE "bot_id" = ${sara.brickId}`;
    await sweepComputers(new Date());
    expect((await prisma.brickComputer.findUniqueOrThrow({ where: { botId: sara.brickId } })).machine).toBe('resting');
  });

  it('keeps a person’s results when their Brick is deleted and removed for good: only the Brick’s name and its job’s title on them go', async () => {
    const omar = await person('omar');
    const id = await started(omar);
    out(id, 'a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    await keepReportTold(id, 'done');
    expect(kept.size).toBe(1);
    const fileId = (await prisma.computerJobFile.findFirstOrThrow({ where: { jobId: id } })).id;
    expect((await resultsOf(omar.brickId, omar.id))[0].brick).toBe("omar's Brick");
    expect(await orphanResultsOf(omar.id)).toEqual([]);
    // The tap on Delete: the Brick waits out its Undo days. Its results are listed as from a deleted Brick, and still open
    await deleteBrick(omar.brickId, omar.id, NOW);
    expect((await orphanResultsOf(omar.id)).map((one) => [one.name, one.brick, one.brickId])).toEqual([['a.pdf', DELETED_BRICK_LABEL, omar.brickId]]);
    // The Brick comes back (Undo): its results are on its own Files again
    // (checked below on a second Brick; this one is removed for good)
    const later = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);
    removeFails = true;
    // The bucket not answering holds nothing back: results are not touched when a Brick goes
    expect(await removeGoneBricks(later, omar.id)).toEqual([omar.brickId]);
    removeFails = false;
    expect(kept.size).toBe(1);
    expect(await prisma.bot.count({ where: { id: omar.brickId } })).toBe(0);
    // The job rows went with the Brick; the file did not: it keeps its owner and where it came from, and no job, but no name or title of the Brick's
    const row = await prisma.computerJobFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(row).toMatchObject({ jobId: null, botId: omar.brickId, ownerId: omar.id, makerName: DELETED_BRICK_LABEL, jobTitle: 'A job' });
    // Neither the Brick's name nor its job's title is kept anywhere: the result row it was handed over as has the neutral name too
    expect(await prisma.ownedResult.findUniqueOrThrow({ where: { id: row.resultId as string } })).toMatchObject({ makerBotId: omar.brickId, makerName: DELETED_BRICK_LABEL });
    expect(row.resultId).not.toBeNull();
    const orphans = await orphanResultsOf(omar.id);
    expect(orphans.map((one) => [one.name, one.brick, one.jobId, one.delivery])).toEqual([['a.pdf', DELETED_BRICK_LABEL, null, 'not_delivered']]);
    // Only its owner opens or deletes it; the copy comes back whole
    expect((await readOwnResult(omar.id, fileId))?.data.toString()).toBe('a');
    const mia = await person('mia');
    expect(await readOwnResult(mia.id, fileId)).toBeNull();
    expect(await deleteOwnResult(mia.id, fileId)).toBe(false);
    expect(await orphanResultsOf(mia.id)).toEqual([]);
    expect(await deleteOwnResult(omar.id, fileId)).toBe(true);
    expect(kept.size).toBe(0);
    expect(await readOwnResult(omar.id, fileId)).toBeNull();
  });

  it('lists every result of deleted Bricks, however many results a person has, a page at a time', async () => {
    const sara = await person('sara');
    const gone = await createBrick({ ownerId: sara.id, name: 'Gone' });
    // 120 results of the deleted Brick (older), then 520 newer ones from the Brick that stays: the old ones are not lost behind the newer
    const rows = (botId: string, count: number, from: number, jobTitle: string) =>
      Array.from({ length: count }, (_, n) => ({ botId, ownerId: sara.id, makerName: 'x', jobTitle, name: `f${from + n}.pdf`, path: `Outputs/${randomUUID()}/f${from + n}.pdf`, modifiedAt: new Date(NOW.getTime() + n), bytes: 1, mimeType: 'application/pdf', createdAt: new Date(NOW.getTime() - (1000 - from - n) * 1000) }));
    await prisma.computerJobFile.createMany({ data: [...rows(gone.id, 120, 0, 'old'), ...rows(sara.brickId, 520, 120, 'new')].map((row) => ({ ...row })) });
    // Only rows with a result are listed: give each a result record
    const files = await prisma.computerJobFile.findMany({ where: { ownerId: sara.id }, select: { id: true, name: true, bytes: true, botId: true } });
    for (const file of files) {
      const kept = await prisma.ownedResult.create({ data: { ownerId: sara.id, sourceKind: 'computer_job', sourceId: file.id, makerBotId: file.botId, makerName: 'x', name: file.name, contentType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64), storageKey: `test/${file.id}` } });
      await prisma.computerJobFile.update({ where: { id: file.id }, data: { resultId: kept.id } });
    }
    await deleteBrick(gone.id, sara.id, NOW);
    const first = await orphanResultsPage(sara.id, { limit: 100 });
    expect(first?.results).toHaveLength(100);
    expect(first?.next).not.toBeNull();
    const second = await orphanResultsPage(sara.id, { limit: 100, cursor: first?.next });
    expect(second?.results).toHaveLength(20);
    expect(second?.next).toBeNull();
    expect(new Set([...(first?.results ?? []), ...(second?.results ?? [])].map((one) => one.id)).size).toBe(120);
    expect([...(first?.results ?? []), ...(second?.results ?? [])].every((one) => one.brick === DELETED_BRICK_LABEL && one.jobTitle === 'old')).toBe(true);
    expect(await orphanResultsPage(sara.id, { cursor: 'nonsense' })).toBeNull();
  });

  it('gives the results back to the Brick’s own Files when Undo brings it back', async () => {
    const sara = await person('sara');
    const id = await started(sara);
    out(id, 'a.pdf', 'a', 5);
    await finishJob(id, 'done', minutes(9));
    await deleteBrick(sara.brickId, sara.id, NOW);
    expect((await orphanResultsOf(sara.id)).map((one) => one.name)).toEqual(['a.pdf']);
    expect(await undoBrickDelete(sara.brickId, sara.id, NOW)).not.toBeNull();
    expect(await orphanResultsOf(sara.id)).toEqual([]);
    expect((await resultsOf(sara.brickId, sara.id))[0]).toMatchObject({ name: 'a.pdf', brick: "sara's Brick" });
  });
  describe('the room of a job that hands its files over is settled once, at what the hand-over made its time', () => {
    const roomOf = (jobId: string) => prisma.meterReservation.findFirstOrThrow({ where: { jobId, reservationKey: { startsWith: 'computer:job:' } } });
    const priced = (seconds: number) => BigInt(Math.max(1, costOfSeconds(seconds, provider.microsPerMinute()) ?? 1));

    it('gap (a): the end write itself says the hand-over is still to come, so a sweep between the end and the hand-over’s first beat does not settle the room at the shorter time', async () => {
      const sara = await person('sara');
      // Started long ago: its room has lapsed for the sweep that runs right after the end
      const id = await started(sara, 'Visa form', minutes(-60));
      out(id, 'a.pdf', 'a', -5);
      const slow = provider.execAnswer;
      provider.execAnswer = async (command) => {
        if (command.includes('find "$d"')) await new Promise((resolve) => setTimeout(resolve, 1600));
        return slow(command);
      };
      const revoke = revokeJobTokens as jest.Mock;
      const real = revoke.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
      let during: { handOverAliveAt: Date | null; status: string; state: string } | null = null;
      revoke.mockImplementationOnce(async (...args: unknown[]) => {
        // The job is over (the end is written) and its hand-over has not begun: the sweep runs now
        await sweepComputers(minutes(-1));
        const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
        during = { handOverAliveAt: job.handOverAliveAt, status: job.status, state: (await roomOf(id)).state };
        return real(...args);
      });
      await finishJob(id, 'done', minutes(-1));
      expect(during).toMatchObject({ status: 'done', state: 'held' });
      expect((during as unknown as { handOverAliveAt: Date | null }).handOverAliveAt).not.toBeNull();
      // The hand-over added the seconds it took, and the room was settled once, at the whole
      const job = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
      expect(job.secondsRun).toBeGreaterThan(59 * 60);
      expect(job.secondsRun).toBeGreaterThanOrEqual(Math.round((minutes(-1).getTime() - minutes(-60).getTime()) / 1000) + 1);
      const room = await roomOf(id);
      expect(room.state).toBe('settled');
      expect(room.settledMicros).toBe(priced(job.secondsRun));
      expect((await prisma.meterEvent.findUniqueOrThrow({ where: { eventId: `computer:${id}:time` } })).quantity).toBe(BigInt(job.secondsRun));
    });

    it('gap (b): a hand-over that finishes between the sweep’s two reads is never settled at the seconds from before it, whichever of the two reads comes first', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const started_ = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', writes: false }, minutes(-60));
      if (!started_.ok) throw new Error('no job');
      const id = started_.job.id;
      await finishJob(id, 'done', minutes(-1));
      // A hand-over is in progress for it (the machine's files are claimed) and its room is still held, lapsed
      await prisma.meterReservation.updateMany({ where: { jobId: id, reservationKey: { startsWith: 'computer:job:' } }, data: { state: 'held', settledMicros: null, closedAt: null, expiresAt: minutes(-30) } });
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
      const before = (await prisma.computerJob.findUniqueOrThrow({ where: { id } })).secondsRun;
      const room = await roomOf(id);
      // The sweep reads two things to decide: the machine's claim and the job's seconds and beat. Whichever it reads FIRST gets what was there before the hand-over
      // finished; the hand-over finishes (its seconds added, the claim and the beat let go) right after that read, so the SECOND read sees it finished
      const realLease = prisma.meterReservation.findUnique.bind(prisma.meterReservation);
      const realClaim = prisma.brickComputer.findUnique.bind(prisma.brickComputer);
      const realJob = prisma.computerJob.findUnique.bind(prisma.computerJob);
      let armed = false;
      let first: 'claim' | 'job' | null = null;
      const finishHandOver = async () => {
        await prisma.computerJob.update({ where: { id }, data: { secondsRun: { increment: 7 }, handOverAliveAt: null } });
        await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
      };
      const leaseSpy = jest.spyOn(prisma.meterReservation, 'findUnique').mockImplementation(((args: { where?: { reservationKey?: string } }) => {
        if (args?.where?.reservationKey === room.reservationKey) armed = true;
        return realLease(args as never);
      }) as never);
      const claimSpy = jest.spyOn(prisma.brickComputer, 'findUnique').mockImplementation(((args: { where?: { botId?: string } }) => {
        const read = realClaim(args as never);
        if (!armed || first || args?.where?.botId !== sara.brickId) return read;
        first = 'claim';
        return read.then(async (value) => {
          await finishHandOver();
          return value;
        });
      }) as never);
      const jobSpy = jest.spyOn(prisma.computerJob, 'findUnique').mockImplementation(((args: { where?: { id?: string }; select?: { handOverAliveAt?: boolean } }) => {
        const read = realJob(args as never);
        if (!armed || first || args?.where?.id !== id || !args?.select?.handOverAliveAt) return read;
        first = 'job';
        return read.then(async (value) => {
          await finishHandOver();
          return value;
        });
      }) as never);
      let afterFirstSweep: Awaited<ReturnType<typeof roomOf>> | null = null;
      try {
        await sweepComputers(new Date());
        afterFirstSweep = await roomOf(id);
      } finally {
        leaseSpy.mockRestore();
        claimSpy.mockRestore();
        jobSpy.mockRestore();
      }
      expect(first).not.toBeNull();
      const after = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
      expect(after.secondsRun).toBe(before + 7);
      // Never at the seconds from before the hand-over: held for the next sweep, or settled at the whole
      if (afterFirstSweep?.state === 'settled') expect(afterFirstSweep.settledMicros).toBe(priced(after.secondsRun));
      await sweepComputers(new Date());
      expect((await roomOf(id)).state).toBe('settled');
      expect((await roomOf(id)).settledMicros).toBe(priced(after.secondsRun));
    });

    it('a job that ended at 0 seconds keeps its room while a hand-over may still add seconds, then settles at what the hand-over made it, or is given back when none came', async () => {
      const sara = await person('sara');
      await giveComputer(sara.brickId, sara.id);
      const started_ = await startJob({ botId: sara.brickId, personId: sara.id, title: 'Visa form', writes: false }, minutes(-60));
      if (!started_.ok) throw new Error('no job');
      const id = started_.job.id;
      await finishJob(id, 'done', minutes(-1));
      // Ended at 0 seconds, room still held and lapsed, and a hand-over is in progress (the machine's files are claimed)
      await prisma.computerJob.update({ where: { id }, data: { secondsRun: 0 } });
      await prisma.meterReservation.updateMany({ where: { jobId: id, reservationKey: { startsWith: 'computer:job:' } }, data: { state: 'held', settledMicros: null, closedAt: null, expiresAt: minutes(-30) } });
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: new Date() } });
      await sweepComputers(new Date());
      // Not given back while the hand-over may still add seconds
      expect((await roomOf(id)).state).toBe('held');
      // The hand-over adds its seconds and lets go; the next sweep settles the room at the whole
      await prisma.computerJob.update({ where: { id }, data: { secondsRun: { increment: 42 }, handOverAliveAt: null } });
      await prisma.brickComputer.updateMany({ where: { botId: sara.brickId }, data: { filesClaimedAt: null } });
      await sweepComputers(new Date());
      expect(await roomOf(id)).toMatchObject({ state: 'settled', settledMicros: priced(42) });

      // A job that ended at 0 seconds with no hand-over at all (no claim, no beat) is given back, as before
      const other = await person('tom');
      await giveComputer(other.brickId, other.id);
      const idle = await startJob({ botId: other.brickId, personId: other.id, title: 'Idle', writes: false }, minutes(-60));
      if (!idle.ok) throw new Error('no job');
      await finishJob(idle.job.id, 'done', minutes(-1));
      await prisma.computerJob.update({ where: { id: idle.job.id }, data: { secondsRun: 0, handOverAliveAt: null } });
      await prisma.meterReservation.updateMany({ where: { jobId: idle.job.id, reservationKey: { startsWith: 'computer:job:' } }, data: { state: 'held', settledMicros: null, closedAt: null, expiresAt: minutes(-30) } });
      await prisma.brickComputer.updateMany({ where: { botId: other.brickId }, data: { filesClaimedAt: null } });
      await sweepComputers(new Date());
      expect((await roomOf(idle.job.id)).state).toBe('released');
    });

    it('a crashed ending whose mark ages out is settled by the sweep exactly once: not while the mark is young, then once at what the job ran, however often the sweep comes back', async () => {
      const sara = await person('sara');
      const id = await started(sara, 'Visa form', minutes(-60));
      out(id, 'a.pdf', 'a', -5);
      const revoke = revokeJobTokens as jest.Mock;
      revoke.mockImplementationOnce(() => {
        throw new Error('the server stopped here');
      });
      await expect(finishJob(id, 'done', minutes(-1))).rejects.toThrow('the server stopped here');
      // Over, with its mark and no hand-over (nobody is running it), no time written, its room held and lapsed
      const crashed = await prisma.computerJob.findUniqueOrThrow({ where: { id } });
      expect(crashed).toMatchObject({ status: 'done' });
      expect(crashed.handOverAliveAt?.getTime()).toBe(minutes(-1).getTime());
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(0);
      // While the mark is young the sweep leaves it to its hand-over
      await sweepComputers(new Date(minutes(-1).getTime() + 10_000));
      expect((await roomOf(id)).state).toBe('held');
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(0);
      // Once it has aged out the job is settled at what it ran, once
      const later = new Date(minutes(-1).getTime() + 10 * 60_000);
      await sweepComputers(later);
      await sweepComputers(new Date(later.getTime() + 60_000));
      await sweepComputers(new Date(later.getTime() + 120_000));
      const room = await roomOf(id);
      expect(room.state).toBe('settled');
      expect(room.settledMicros).toBe(priced(crashed.secondsRun));
      expect(await prisma.meterEvent.count({ where: { eventId: `computer:${id}:time` } })).toBe(1);
    });
  });
});
