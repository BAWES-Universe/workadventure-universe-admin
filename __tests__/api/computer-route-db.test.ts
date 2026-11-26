/**
 * Choosing the way by expected cost, against a real database with the PRETEND provider: a job on the computer is refused while a connected
 * app would do it for less, and every job carries the way it took and what it was expected to cost. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/computer-route-db.test.ts
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));

import { prisma } from '@/lib/db';
import { createBrick } from '@/lib/brick-create';
import { saveMeterSettings } from '@/lib/meter';
import { FakeComputerProvider, setComputerProviderForTests } from '@/lib/computer-provider';
import { giveComputer, reviewAppSteps, startJob, startWindDown } from '@/lib/computer';
import { connectedApp } from '@/lib/computer-route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const NOW = new Date('2026-11-15T12:00:00Z');
const people: string[] = [];
let made = 0;
let provider: FakeComputerProvider;
const env = process.env.COMPUTER_PROVIDER;

async function sara(): Promise<{ id: string; brickId: string }> {
  const unique = `route-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name: 'sara' } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: 'Brick' });
  await giveComputer(brick.id, user.id);
  return { id: user.id, brickId: brick.id };
}

/** A ready-made app this person connected and gave to the Brick. */
async function connect(owner: string, botId: string, over: { name?: string; toolkit?: string; confirmed?: boolean; enabled?: boolean } = {}) {
  const connection = await prisma.appConnection.create({
    data: {
      ownerId: owner,
      name: over.name ?? 'Notion',
      serverUrl: 'https://app.example.test/link',
      source: 'ready_made',
      providerToolkit: over.toolkit ?? 'notion',
      providerAccountId: 'acct',
      providerConfirmedAt: over.confirmed === false ? null : new Date(),
    },
  });
  await prisma.botMcpServer.create({ data: { botId, name: over.name ?? 'Notion', serverUrl: 'https://app.example.test/link', authType: 'none', connectionId: connection.id, enabled: over.enabled ?? true } });
}

const wipe = async () => {
  await prisma.computerJob.deleteMany({ where: { personId: { in: people } } });
  await prisma.meterReservation.deleteMany({});
  await prisma.meterEvent.deleteMany({});
  await prisma.botMcpServer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
  await prisma.appConnection.deleteMany({ where: { ownerId: { in: people } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'computer-wind-down'] } } });
};

run('choosing the way by expected cost, in a real database', () => {
  beforeAll(() => {
    process.env.COMPUTER_PROVIDER = 'fake';
  });
  beforeEach(async () => {
    await wipe();
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    provider = new FakeComputerProvider();
    setComputerProviderForTests(provider);
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, appUseCeilingMicros: 50_000_000, appUseMemberCeilingMicros: 5_000_000 }, 'admin');
  });
  afterAll(async () => {
    await wipe();
    setComputerProviderForTests(null);
    process.env.COMPUTER_PROVIDER = env;
    await prisma.brickComputer.deleteMany({ where: { bot: { ownerId: { in: people } } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    await prisma.$disconnect();
  });

  const woke = () => provider.calls.filter((call) => call.name === 'create' || call.name === 'wake').length;

  it('refuses a job on the computer while a connected app would do it for less, leaves no job behind and wakes nothing', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    const started = await startJob({ botId: person.brickId, personId: person.id, title: 'Add a page', plan: { app: 'Notion', steps: 3 } }, NOW);
    expect(started).toEqual({ ok: false, reason: 'cheaper_route', app: 'Notion' });
    expect(await prisma.computerJob.count({ where: { personId: person.id } })).toBe(0);
    expect(woke()).toBe(0);
  });

  describe('the person\'s own copy of an App comes first', () => {
    /** The person's own App added by its link, given to the Brick. */
    async function connectOwn(owner: string, botId: string, name: string, serverUrl: string) {
      const connection = await prisma.appConnection.create({ data: { ownerId: owner, name, serverUrl, source: 'link' } });
      await prisma.botMcpServer.create({ data: { botId, name, serverUrl: '', authType: 'none', connectionId: connection.id } });
    }
    /** This person's own Limit for paid App steps is used up, so the ready-made copy is no way at all. */
    const useUpLimit = (person: { id: string; brickId: string }) =>
      prisma.meterEvent.create({
        data: { eventId: `ev-${randomUUID()}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: `person:${person.id}`, personId: person.id, botId: person.brickId, brick: true, payerKind: 'universe', route: 'app', quantity: BigInt(1), unit: 'call', costMicros: BigInt(5_000_000), basis: 'measured' },
      });

    it('takes the person\'s own copy of the same name over the ready-made one, at no cost to Universe, whichever was given first', async () => {
      const person = await sara();
      await connect(person.id, person.brickId, { name: 'Notion', toolkit: 'notion' });
      await connectOwn(person.id, person.brickId, 'Notion', 'https://mcp.notion.com/mcp');
      await useUpLimit(person);
      expect(await startJob({ botId: person.brickId, personId: person.id, title: 'Add a page', plan: { app: 'Notion', steps: 3 } }, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'Notion' });
      expect(await prisma.computerJob.count({ where: { personId: person.id } })).toBe(0);
    });

    it('takes the person\'s own copy when the model names the ready-made one and theirs has another name (matched by its address)', async () => {
      const person = await sara();
      await connect(person.id, person.brickId, { name: 'Exa', toolkit: 'exa' });
      await connectOwn(person.id, person.brickId, 'My search', 'https://mcp.exa.ai/mcp');
      await useUpLimit(person);
      expect(await startJob({ botId: person.brickId, personId: person.id, title: 'Look it up', plan: { app: 'Exa', steps: 3 } }, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'My search' });
    });

    it('takes the person\'s working own copy under another name even when the named ready-made one is signed out, and nothing when neither works', async () => {
      const person = await sara();
      await connect(person.id, person.brickId, { name: 'Exa', toolkit: 'exa' });
      await connectOwn(person.id, person.brickId, 'My search', 'https://mcp.exa.ai/mcp');
      await prisma.appConnection.updateMany({ where: { ownerId: person.id, source: 'ready_made' }, data: { signInLostAt: NOW } });
      expect(await connectedApp(person.brickId, 'Exa')).toEqual({ name: 'My search', stepMicros: 0 });
      await prisma.appConnection.updateMany({ where: { ownerId: person.id, source: 'link' }, data: { signInLostAt: NOW, signInLostStatus: 401 } });
      expect(await connectedApp(person.brickId, 'Exa')).toBeNull();
    });

    it('never weighs an own copy the bot server saw fail, also when it has the very name asked for: with no working way the job takes the computer', async () => {
      const person = await sara();
      await connectOwn(person.id, person.brickId, 'Exa', 'https://mcp.exa.ai/mcp');
      await prisma.appConnection.updateMany({ where: { ownerId: person.id, source: 'link' }, data: { signInLostAt: NOW, signInLostStatus: 401 } });
      // Alone: a link that is not signed in through the App's site counts as connected, but its key was refused
      expect(await connectedApp(person.brickId, 'Exa')).toBeNull();
      // With a ready-made Exa that is signed out too: neither works
      await connect(person.id, person.brickId, { name: 'Exa', toolkit: 'exa' });
      await prisma.appConnection.updateMany({ where: { ownerId: person.id, source: 'ready_made' }, data: { signInLostAt: NOW } });
      expect(await connectedApp(person.brickId, 'Exa')).toBeNull();
      const plan = { botId: person.brickId, personId: person.id, title: 'Look it up', plan: { app: 'Exa', steps: 3 } };
      expect(await startJob(plan, NOW)).toMatchObject({ ok: true });
    });

    it('never takes an own copy the bot server saw fail (a refused key, or no answer) over a working ready-made one', async () => {
      const person = await sara();
      await connect(person.id, person.brickId, { name: 'Exa', toolkit: 'exa' });
      await connectOwn(person.id, person.brickId, 'My search', 'https://mcp.exa.ai/mcp');
      const plan = { botId: person.brickId, personId: person.id, title: 'Look it up', plan: { app: 'Exa', steps: 3 } };
      expect(await startJob(plan, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'My search' });
      // Its key refused: the ready-made one is the way again
      await prisma.appConnection.updateMany({ where: { ownerId: person.id, source: 'link' }, data: { signInLostAt: NOW, signInLostStatus: 401 } });
      expect(await startJob(plan, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'Exa' });
      // Mended, then its server stops answering on this Brick: the same
      await prisma.appConnection.updateMany({ where: { ownerId: person.id, source: 'link' }, data: { signInLostAt: null, signInLostStatus: null } });
      expect(await startJob(plan, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'My search' });
      await prisma.botMcpServer.updateMany({ where: { botId: person.brickId, connection: { source: 'link' } }, data: { noAnswerAt: NOW } });
      expect(await startJob(plan, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'Exa' });
  });
  });

  it('sends the job to the computer when the App is the cheaper way but its spending stop would refuse the step: the month\u2019s Limit used up, this person\u2019s own, or no Limit set', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    const plan = { app: 'Notion', steps: 3 };
    // Used up for this person: what they have already used this month is all of their Limit
    await prisma.meterEvent.create({
      data: { eventId: `ev-${randomUUID()}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: `person:${person.id}`, personId: person.id, botId: person.brickId, brick: true, payerKind: 'universe', route: 'app', quantity: BigInt(1), unit: 'call', costMicros: BigInt(5_000_000), basis: 'measured' },
    });
    const own = await startJob({ botId: person.brickId, personId: person.id, title: 'Add a page', plan }, NOW);
    expect(own.ok && own.job.status).toBeTruthy();
    expect(await prisma.computerJob.count({ where: { personId: person.id } })).toBe(1);
    await prisma.computerJob.deleteMany({ where: { personId: person.id } });
    await prisma.meterEvent.deleteMany({});
    await prisma.meterReservation.deleteMany({});
    // The whole month used up by others
    await prisma.meterEvent.create({
      data: { eventId: `ev-${randomUUID()}`, kind: 'app_use', pool: 'chat', occurredAt: NOW, personKey: 'person:someone-else', botId: person.brickId, brick: true, payerKind: 'universe', route: 'app', quantity: BigInt(1), unit: 'call', costMicros: BigInt(50_000_000), basis: 'measured' },
    });
    expect((await startJob({ botId: person.brickId, personId: person.id, title: 'Add a page', plan }, NOW)).ok).toBe(true);
    await prisma.computerJob.deleteMany({ where: { personId: person.id } });
    await prisma.meterEvent.deleteMany({});
    await prisma.meterReservation.deleteMany({});
    // No Limit set at all: nothing is let through, so nothing is sent to an App
    await saveMeterSettings({ memberAllowanceMicros: 1_000_000, poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, appUseCeilingMicros: null, appUseMemberCeilingMicros: null }, 'admin');
    expect((await startJob({ botId: person.brickId, personId: person.id, title: 'Add a page', plan }, NOW)).ok).toBe(true);
  });

  it('weighs the spending stop at the moment the job is started, not at the moment of the real clock: a Limit used up in the month of that moment sends the job to the computer', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    const plan = { app: 'Notion', steps: 3 };
    // A month that is not the month of the real clock: the old check read the real month, saw nothing used and sent the job to the App
    const june = new Date('2026-06-15T12:00:00Z');
    await prisma.meterEvent.create({
      data: { eventId: `ev-${randomUUID()}`, kind: 'app_use', pool: 'chat', occurredAt: june, personKey: `person:${person.id}`, personId: person.id, botId: person.brickId, brick: true, payerKind: 'universe', route: 'app', quantity: BigInt(1), unit: 'call', costMicros: BigInt(5_000_000), basis: 'measured' },
    });
    const started = await startJob({ botId: person.brickId, personId: person.id, title: 'Add a page', plan }, june);
    expect(started.ok).toBe(true);
    await prisma.meterEvent.deleteMany({});
  });

  it('does not weigh an app whose step count was not given (or is not a count): a guess of one step would send every such job away from the computer', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    for (const plan of [{ app: 'Notion' }, { app: 'Notion', steps: null }, { app: 'Notion', steps: 0 }, { app: 'Notion', steps: Number.NaN }]) {
      const started = await startJob({ botId: person.brickId, personId: person.id, title: `Job ${JSON.stringify(plan)}`, plan }, NOW);
      expect(started).toMatchObject({ ok: true });
      if (started.ok) await prisma.computerJob.deleteMany({ where: { personId: person.id } });
    }
  });

  it('runs the job when the Brick says why the app cannot do it, and writes the way and what it was expected to cost on the job', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    const started = await startJob({ botId: person.brickId, personId: person.id, title: 'Visa form', plan: { app: 'Notion', steps: 3, appCannot: 'The job is on a website screen' } }, NOW);
    expect(started.ok).toBe(true);
    const job = await prisma.computerJob.findFirstOrThrow({ where: { personId: person.id } });
    expect(job.route).toBe('computer');
    expect(Number(job.expectedMicros)).toBeGreaterThan(0);
  });

  it('runs the job when the app would take so many steps that the computer is cheaper', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    // A Brick with no machine yet would also make a disk, so only a very long app route loses to it
    expect(await startJob({ botId: person.brickId, personId: person.id, title: 'Sort a thousand rows', plan: { app: 'Notion', steps: 450 } }, NOW)).toMatchObject({ ok: true });
  });

  it('weighs the computer without the disk once the Brick has a machine', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    await prisma.brickComputer.update({ where: { botId: person.brickId }, data: { providerRef: 'm1', machine: 'resting' } });
    expect(await startJob({ botId: person.brickId, personId: person.id, title: 'A little', plan: { app: 'Notion', steps: 20 } }, NOW)).toMatchObject({ ok: false, reason: 'cheaper_route' });
    expect(await startJob({ botId: person.brickId, personId: person.id, title: 'A lot', plan: { app: 'Notion', steps: 80 } }, NOW)).toMatchObject({ ok: true });
  });

  it('does not count an app that is not there for this Brick: one never connected, one not signed in yet, and one the Brick has switched off', async () => {
    const person = await sara();
    await connect(person.id, person.brickId, { name: 'Linear', toolkit: 'linear', confirmed: false });
    await connect(person.id, person.brickId, { name: 'Asana', toolkit: 'asana', enabled: false });
    for (const app of ['Slack', 'Linear', 'Asana']) {
      const started = await startJob({ botId: person.brickId, personId: person.id, title: `Job ${app}`, plan: { app, steps: 2 } }, NOW);
      expect(started).toMatchObject({ ok: true });
    }
  });

  it('finds the app by the name it was connected under or by the app it is, in any case', async () => {
    const person = await sara();
    await connect(person.id, person.brickId, { name: 'Team wiki', toolkit: 'notion' });
    expect(await startJob({ botId: person.brickId, personId: person.id, title: 'Job', plan: { app: 'NOTION', steps: 2 } }, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'Team wiki' });
    expect(await startJob({ botId: person.brickId, personId: person.id, title: 'Job', plan: { app: 'team  WIKI', steps: 2 } }, NOW)).toEqual({ ok: false, reason: 'cheaper_route', app: 'Team wiki' });
  });

  it('starts a job with no plan as before, with the computer as its way', async () => {
    const person = await sara();
    await connect(person.id, person.brickId);
    expect((await startJob({ botId: person.brickId, personId: person.id, title: 'Job' }, NOW)).ok).toBe(true);
    const job = await prisma.computerJob.findFirstOrThrow({ where: { personId: person.id } });
    expect(job).toMatchObject({ route: 'computer' });
    expect(Number(job.expectedMicros)).toBeGreaterThan(0);
  });

  it('answers a run that is not theirs with no_run before the way is weighed', async () => {
    const person = await sara();
    // No run exists for this id, so the refusal for a run that is not theirs comes first, as it always did
    expect(await startJob({ botId: person.brickId, personId: person.id, title: 'Job', runId: randomUUID(), plan: { app: 'Notion', steps: 2 } }, NOW)).toEqual({ ok: false, reason: 'no_run' });
  });

  describe('the review at 20 app steps', () => {
    const withMachine = (botId: string) => prisma.brickComputer.update({ where: { botId }, data: { providerRef: 'm1', machine: 'resting' } });

    it('asks for a look when the steps so far cost as much as the job on the computer, and changes nothing', async () => {
      const person = await sara();
      await connect(person.id, person.brickId);
      await withMachine(person.brickId);
      expect(await reviewAppSteps(person.brickId, person.id, { app: 'Notion', steps: 80 })).toEqual({ review: true });
      expect(woke()).toBe(0);
      expect(await prisma.computerJob.count({ where: { personId: person.id } })).toBe(0);
      expect(await prisma.meterEvent.count({})).toBe(0);
    });

    it('asks for nothing while the steps still cost less', async () => {
      const person = await sara();
      await connect(person.id, person.brickId);
      await withMachine(person.brickId);
      expect(await reviewAppSteps(person.brickId, person.id, { app: 'Notion', steps: 20 })).toEqual({ review: false });
    });

    it('has nothing to say where there is no computer to move to: one that is off, a Brick that is not theirs, or a wind-down', async () => {
      const person = await sara();
      const other = await sara();
      await connect(person.id, person.brickId);
      await withMachine(person.brickId);
      expect(await reviewAppSteps(person.brickId, other.id, { app: 'Notion', steps: 80 })).toEqual({ review: false });
      await startWindDown('team');
      expect(await reviewAppSteps(person.brickId, person.id, { app: 'Notion', steps: 80 })).toEqual({ review: false });
      await prisma.appSetting.deleteMany({ where: { key: 'computer-wind-down' } });
      await prisma.brickComputer.update({ where: { botId: person.brickId }, data: { enabled: false } });
      expect(await reviewAppSteps(person.brickId, person.id, { app: 'Notion', steps: 80 })).toEqual({ review: false });
    });

    it('prices a name that matches no connected app (disconnected since, or named differently) at the dearest rate, never at nothing: the advice is only a line', async () => {
      const person = await sara();
      await withMachine(person.brickId);
      expect(await reviewAppSteps(person.brickId, person.id, { app: 'Mystery', steps: 12 })).toEqual({ review: true });
    });
  });
});
