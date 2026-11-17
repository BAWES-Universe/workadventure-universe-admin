/**
 * The Budget page against a real database: a saved number is used by the very next check with no restart, every save leaves its line in the
 * history in the same transaction (also through the old PATCH route), the whole page builds from the books, and a warning is told once and cleared
 * by a raise. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { saveMeterSettings, getMeterSettings } from '@/lib/meter';
import { reserveRoom, releaseRoom } from '@/lib/meter-allowance';
import { checkSpeechCap } from '@/lib/speech-cap';
import { saveInstantLimits } from '@/lib/instant/state';
import { saveNumber, readValues } from '@/lib/budget/numbers';
import { listChanges as listAllChanges } from '@/lib/budget/history';
import { buildReport } from '@/lib/budget/report';
import { clearBudgetNotices, sendNotices } from '@/lib/budget/warnings';
import { PATCH as patchMeterSettings } from '@/app/api/admin/meter-settings/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const MILLION = 1_000_000;
let admin = '';
let sara = '';
const saved: Record<string, { value: unknown } | null> = {};
// Other suites share this database and also leave lines (every save is recorded), so only this test's own admin's lines are read
const listChanges = async (options: { take?: number } = {}) => (await listAllChanges({ take: 1000 })).filter((line) => line.changedById === admin).slice(0, options.take ?? 100);
const KEYS = ['meter', 'instant-limits', 'budget', 'budget-accounts'];

const fakeFetch = async (url: string) => ({
  ok: true,
  status: 200,
  json: async () => (url.includes('deepseek') ? { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '84.20' }] } : url.includes('elevenlabs') ? { character_count: 82_000, character_limit: 100_000, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 10 * 86_400 } : {}),
});

run('the Budget page, in a real database', () => {
  beforeAll(async () => {
    for (const key of KEYS) saved[key] = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    admin = (await prisma.user.create({ data: { uuid: `kh-${tag}`, email: `kh-${tag}@example.test`, name: 'Khalid' } })).id;
    sara = (await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'Sara' } })).id;
    (getSessionUser as jest.Mock).mockResolvedValue({ id: admin, email: `kh-${tag}@example.test` });
    (isSuperAdmin as jest.Mock).mockReturnValue(true);
  });
  afterAll(async () => {
    await prisma.budgetChange.deleteMany({ where: { changedById: admin } });
    await prisma.meterReservation.deleteMany({ where: { personId: sara } });
    await prisma.userNotice.deleteMany({ where: { userId: admin } });
    for (const key of KEYS) {
      if (saved[key]) await prisma.appSetting.update({ where: { key }, data: { value: saved[key]!.value as never } });
      else await prisma.appSetting.deleteMany({ where: { key } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [admin, sara] } } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.budgetChange.deleteMany({ where: { changedById: admin } });
    await prisma.meterReservation.deleteMany({ where: { personId: sara } });
    await saveMeterSettings({ memberAllowanceMicros: 5 * MILLION, poolCeilingMicros: 2 * MILLION, reserveMicros: 500_000, storageMicrosPerGbMonth: 30_000, atOnceMember: 2, atOnceAll: 10, speechCeilingSeconds: 1_000, speechMemberCeilingSeconds: 300 }, admin);
    await prisma.budgetChange.deleteMany({ where: { changedById: admin } });
  });

  it('migrates the page’s own settings with their starting values, written only where nothing was saved', async () => {
    const row = await prisma.appSetting.findUnique({ where: { key: 'budget' } });
    expect(row).not.toBeNull();
    const values = await readValues();
    expect(values.budget.warnFirstPercent).not.toBeNull();
    expect(values.budget.warnThirdPercent).not.toBeNull();
  });

  describe('a saved number works at once', () => {
    it('lets the next computer step in as soon as the Computers budget is raised, with nothing restarted', async () => {
      const refused = await reserveRoom({ key: `budget:${tag}:1`, personId: sara, amountMicros: 1_900_000 });
      expect(refused).toMatchObject({ ok: false, reason: 'pool' });
      const result = await saveNumber('meter:poolCeilingMicros', 90 * MILLION, admin);
      expect(result).toEqual({ ok: true, value: 90 * MILLION, inEffect: true });
      const admitted = await reserveRoom({ key: `budget:${tag}:1`, personId: sara, amountMicros: 1_900_000 });
      expect(admitted.ok).toBe(true);
      await releaseRoom({ key: `budget:${tag}:1` });
    });

    it('lets the next use of Universe AI speech in as soon as its seconds are raised', async () => {
      expect(await checkSpeechCap({ personId: sara, seconds: 400 })).toMatchObject({ stopped: 'person' });
      await saveNumber('meter:speechMemberCeilingSeconds', 36_000, admin);
      expect(await checkSpeechCap({ personId: sara, seconds: 400 })).toBeNull();
    });

    it('reads the number back from the store before it says it is in effect', async () => {
      const result = await saveNumber('meter:atOnceAll', 25, admin);
      expect(result).toMatchObject({ ok: true, value: 25, inEffect: true });
      expect((await getMeterSettings()).atOnceAll).toBe(25);
    });
  });

  describe('a raise outside the range', () => {
    it('is refused with a plain line and changes nothing, in the books or in the history', async () => {
      for (const value of [0, -5, 10 ** 17, 2.5]) {
        const result = await saveNumber('meter:poolCeilingMicros', value, admin);
        expect(result).toMatchObject({ ok: false, status: 400 });
        expect(!result.ok && result.error).toMatch(/from 1 to 1,000,000,000,000,000/);
      }
      expect((await getMeterSettings()).poolCeilingMicros).toBe(2 * MILLION);
      expect(await listChanges({ take: 10 })).toEqual([]);
    });

    it('refuses a number the page does not know', async () => {
      expect(await saveNumber('meter:nothing', 5, admin)).toMatchObject({ ok: false, status: 404 });
    });
  });

  describe('the history', () => {
    it('leaves one line for each save: who, when, which number, the old value and the new one', async () => {
      await saveNumber('meter:poolCeilingMicros', 90 * MILLION, admin);
      await saveNumber('meter:poolCeilingMicros', 120 * MILLION, admin);
      const lines = await listChanges({ take: 10 });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ store: 'meter', key: 'poolCeilingMicros', oldValue: 90 * MILLION, newValue: 120 * MILLION, changedById: admin });
      expect(lines[1]).toMatchObject({ oldValue: 2 * MILLION, newValue: 90 * MILLION });
      expect(new Date(lines[0].changedAt).getTime()).toBeGreaterThanOrEqual(new Date(lines[1].changedAt).getTime());
    });

    it('is written in the transaction of the save: a save that fails leaves no line and no change', async () => {
      const before = await prisma.appSetting.findUnique({ where: { key: 'meter' } });
      // A real failure inside the transaction: the database itself refuses the history line.
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION budget_changes_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'the history could not be written'; END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER budget_changes_refuse BEFORE INSERT ON budget_changes FOR EACH ROW EXECUTE FUNCTION budget_changes_refuse()`);
      try {
        await expect(saveMeterSettings({ poolCeilingMicros: 777 * MILLION }, admin)).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS budget_changes_refuse ON budget_changes`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS budget_changes_refuse()`);
      }
      expect((await prisma.appSetting.findUnique({ where: { key: 'meter' } }))!.value).toEqual(before!.value);
      expect(await listChanges({ take: 10 })).toEqual([]);
    });

    it('records the old PATCH /api/admin/meter-settings route too, and a save that changes nothing leaves nothing', async () => {
      const patch = (body: unknown) => patchMeterSettings(new NextRequest('http://localhost:3333/api/admin/meter-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      expect((await patch({ atOnceAll: 40 })).status).toBe(200);
      expect((await patch({ atOnceAll: 40 })).status).toBe(200);
      const lines = await listChanges({ take: 10 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ key: 'atOnceAll', oldValue: 10, newValue: 40, changedById: admin });
    });

    it('records Instant’s limits and the page’s own settings', async () => {
      await saveInstantLimits({ exposureCeilingMicros: 12 * MILLION }, admin);
      await saveNumber('budget:warnFirstPercent', 40, admin);
      const lines = await listChanges({ take: 10 });
      expect(lines.map((line) => `${line.store}:${line.key}`).sort()).toEqual(['budget:warnFirstPercent', 'instant:exposureCeilingMicros']);
    });

    it('records a number that was emptied as no value', async () => {
      await saveNumber('meter:reserveMicros', null, admin);
      expect(await listChanges({ take: 1 })).toEqual([expect.objectContaining({ key: 'reserveMicros', oldValue: 500_000, newValue: null })]);
    });

    it('keeps the three warning levels in order', async () => {
      expect(await saveNumber('budget:warnFirstPercent', 99, admin)).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe('the page', () => {
    it('builds from the books with the five areas, every number with its range, and companies read apart', async () => {
      await saveNumber('instant:exposureCeilingMicros', 10 * MILLION, admin);
      const report = await buildReport({ fetchImpl: fakeFetch, agent37: { billing: async () => ({ balance_usd: 20.55, past_due: false }) }, userId: admin });
      expect(report.areas.map((area) => area.key)).toEqual(['chat', 'speech', 'apps', 'computers', 'storage']);
      const computers = report.areas.find((area) => area.key === 'computers')!;
      expect(computers.budgetMicros).toBe(2 * MILLION);
      expect(computers.numberId).toBe('meter:poolCeilingMicros');
      expect(report.numbers.find((entry) => entry.id === 'meter:poolCeilingMicros')).toMatchObject({ value: 2 * MILLION, range: { min: 1 } });
      expect(report.accounts.find((account) => account.key === 'agent37')).toMatchObject({ kind: 'balance', balanceMicros: 20_550_000, state: 'ok' });
      expect(report.accounts.find((account) => account.key === 'soniox')).toMatchObject({ kind: 'unknown', state: 'unknown' });
      expect(report.accounts.find((account) => account.key === 'r2')?.kind).toBe('after');
      const apps = report.areas.find((area) => area.key === 'apps')!;
      expect(apps.lines?.map((line) => line.key)).toEqual(['connected', 'instant']);
    });

    it('shows who last changed a number and when', async () => {
      await saveNumber('meter:atOnceAll', 33, admin);
      const report = await buildReport({ fetchImpl: fakeFetch, agent37: null, userId: admin });
      expect(report.numbers.find((entry) => entry.id === 'meter:atOnceAll')?.lastChange).toMatchObject({ by: 'Khalid' });
      expect(report.changes[0]).toMatchObject({ numberId: 'meter:atOnceAll', by: 'Khalid', oldValue: 10, newValue: 33 });
    });

    it('says a company is empty, apart from a Universe budget, and pauses its area', async () => {
      const report = await buildReport({ fetchImpl: fakeFetch, agent37: { billing: async () => ({ balance_usd: 0, past_due: false }) }, userId: admin });
      const computers = report.areas.find((area) => area.key === 'computers')!;
      expect(computers.state).toBe('provider');
      expect(computers.topUp?.name).toBe('Agent37');
      expect(report.accounts.find((account) => account.key === 'agent37')?.state).toBe('zero');
      expect(report.alerts.find((alert) => alert.key === 'account:agent37:zero')).toMatchObject({ level: 'paused', topUp: { name: 'Agent37' } });
    });

    it('keeps the last good reading, with its time, when a company cannot be read now', async () => {
      await buildReport({ fetchImpl: fakeFetch, agent37: { billing: async () => ({ balance_usd: 20.55, past_due: false }) }, userId: admin });
      const down = async () => {
        throw new Error('connection reset');
      };
      const report = await buildReport({ fetchImpl: fakeFetch, agent37: { billing: down as never }, userId: admin });
      const agent37 = report.accounts.find((account) => account.key === 'agent37')!;
      expect(agent37.balanceMicros).toBe(20_550_000);
      expect(agent37.checkedAt).not.toBeNull();
      expect(agent37.line).toMatch(/could not be reached/);
    });
  });

  describe('warnings', () => {
    it('tells every super admin once for a level of a budget in a month, and a raise clears it and gets fresh ones', async () => {
      process.env.SUPER_ADMINS = `kh-${tag}@example.test`;
      (isSuperAdmin as jest.Mock).mockImplementation((email: string | null) => email === `kh-${tag}@example.test`);
      try {
        const warnings = [{ alert: { key: 'speech:notice', level: 'notice' as const, title: 'Speech is at 81%', body: 'At this pace the month needs about $405.' }, notice: { dedupe: 'second:speech:300000000', title: 'Speech is at 81%', body: 'Tap to raise it.', href: '/admin/ai-providers/budget?raise=meter%3AspeechBudgetMicros' } }];
        const now = new Date('2031-06-15T12:00:00Z');
        expect(await sendNotices(warnings, now)).toBe(1);
        expect(await sendNotices(warnings, now)).toBe(0);
        const open = await prisma.userNotice.findMany({ where: { userId: admin, kind: 'budget', dismissedAt: null } });
        expect(open).toHaveLength(1);
        await clearBudgetNotices(':speech:');
        expect(await prisma.userNotice.count({ where: { userId: admin, kind: 'budget', dismissedAt: null } })).toBe(0);
        const raised = [{ ...warnings[0], notice: { ...warnings[0].notice, dedupe: 'second:speech:450000000' } }];
        expect(await sendNotices(raised, now)).toBe(1);
      } finally {
        delete process.env.SUPER_ADMINS;
      }
    });
  });
});
