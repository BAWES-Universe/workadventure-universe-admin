/**
 * Launch defaults (0.5.0): the migration, run on a throwaway database built from every migration before it. A fresh deploy must start
 * with every Limit the computers and Instant Apps need already filled in (small and safe), the platform's rollout budget set, and a default
 * grant for Instant Apps and computers, so nothing is refused for lack of a number and nobody has to type one. A value someone already
 * set is never overwritten, and running it twice changes nothing.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkInstantLimits, INSTANT_LIMIT_RANGES, missingInstantLimits, readInstantLimits } from '@/lib/instant/values';
import { checkMeterSettings, METER_RANGES, missingSettings, readMeterSettings } from '@/lib/meter-values';
import { checkGrant } from '@/lib/credit-rules';

type State = {
  settings: Record<string, Record<string, unknown>>;
  programs: { id: string; category_id: string; kind: string; status: string; created_by_id: string }[];
  rules: { program_id: string; version: number; state: string; funding_account_id: string; covers: string[]; benefit_kind: string; amount: string; schedule: string; share: string; recipient_type: string; settlement: string }[];
};
type Scenario = { before: State; once: State; twice: State };
type Result = { fresh: Scenario; own: Scenario; ended: Scenario };

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-launch-defaults-migration.mjs')], { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 200_000);

describe('launch defaults: a fresh deploy', () => {
  it('starts with nothing set, so these tests fail without the migration', () => {
    expect(result.fresh.before.settings).toEqual({});
    expect(result.fresh.before.programs).toEqual([]);
  });

  it('fills in the six computer Limits, so computers are no longer refused for lack of a number', () => {
    const meter = readMeterSettings(result.fresh.once.settings.meter);
    expect(missingSettings(meter)).toEqual([]);
    expect(meter).toMatchObject({
      memberAllowanceMicros: 250_000, // $0.25 a member a month
      poolCeilingMicros: 2_000_000, // $2.00 a month for the whole pool, under the Agent37 wallet
      reserveMicros: 500_000, // $0.50 kept back
      storageMicrosPerGbMonth: 90_000, // Agent37's disk price, $0.09 a GB a month
      atOnceMember: 1,
      atOnceAll: 3,
    });
  });

  it('sets the platform’s rollout budget, so default grants can issue', () => {
    expect(readMeterSettings(result.fresh.once.settings.meter).rolloutBudgetMicros).toBe(20_000_000);
  });

  it('fills in the four Instant limits, so Instant Apps are no longer refused for lack of a number', () => {
    const limits = readInstantLimits(result.fresh.once.settings['instant-limits']);
    expect(missingInstantLimits(limits)).toEqual([]);
    expect(limits).toMatchObject({ maxRunMicros: 30_000, exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 2000, pauseMinRuns: 10 });
  });

  it('leaves the give-back and markup limits empty (nothing is given back for a failure Universe sees: it is never charged)', () => {
    const limits = readInstantLimits(result.fresh.once.settings['instant-limits']);
    expect([limits.goodwillBudgetMicros, limits.goodwillMaxMicros, limits.goodwillPerPersonPerMonth, limits.markupBps]).toEqual([null, null, null, null]);
  });

  it('keeps the money small: the two ceilings are what can be owed in a month, and the pool ceiling sits under the Agent37 wallet', () => {
    const meter = readMeterSettings(result.fresh.once.settings.meter);
    const limits = readInstantLimits(result.fresh.once.settings['instant-limits']);
    expect(meter.poolCeilingMicros).toBeLessThanOrEqual(2_000_000);
    expect(limits.exposureCeilingMicros).toBeLessThanOrEqual(1_000_000);
    expect(limits.maxRunMicros).toBeLessThanOrEqual(50_000);
    expect(meter.reserveMicros!).toBeLessThan(meter.poolCeilingMicros!);
    expect(meter.memberAllowanceMicros!).toBeLessThan(meter.poolCeilingMicros!);
  });

  it('saves only values the Limits screens would accept (inside their ranges)', () => {
    expect(checkMeterSettings(result.fresh.once.settings.meter).ok).toBe(true);
    expect(checkInstantLimits(result.fresh.once.settings['instant-limits']).ok).toBe(true);
    for (const [key, value] of Object.entries(result.fresh.once.settings.meter)) expect(value).toBeGreaterThanOrEqual(METER_RANGES[key as keyof typeof METER_RANGES].min);
    for (const [key, value] of Object.entries(result.fresh.once.settings['instant-limits'])) expect(value).toBeGreaterThanOrEqual(INSTANT_LIMIT_RANGES[key as keyof typeof INSTANT_LIMIT_RANGES].min);
  });

  it('gives every signed-in member a default: $0.10 of Instant Apps once and the $0.25 computer allowance monthly, paid by the platform, free', () => {
    expect(result.fresh.once.programs.map((p) => [p.id, p.category_id, p.kind, p.status, p.created_by_id])).toEqual([
      ['seed-default-computers', 'computers', 'default', 'active', 'system'],
      ['seed-default-instant_apps', 'instant_apps', 'default', 'active', 'system'],
    ]);
    expect(result.fresh.once.rules).toEqual([
      { program_id: 'seed-default-computers', version: 1, state: 'current', funding_account_id: 'funding-platform', covers: ['computers'], benefit_kind: 'replace', amount: '250000', schedule: 'monthly', share: 'each', recipient_type: 'all', settlement: 'free' },
      { program_id: 'seed-default-instant_apps', version: 1, state: 'current', funding_account_id: 'funding-platform', covers: ['instant_apps'], benefit_kind: 'replace', amount: '100000', schedule: 'once', share: 'each', recipient_type: 'all', settlement: 'free' },
    ]);
  });

  it('seeds defaults the grants rules themselves accept (the same rule check a save goes through)', () => {
    const now = new Date('2026-11-17T00:00:00Z');
    expect(() => checkGrant('default', { categoryId: 'instant_apps', amount: 100_000, schedule: 'once', recipients: { kind: 'all' } }, now)).not.toThrow();
    expect(() => checkGrant('default', { categoryId: 'computers', amount: 250_000, schedule: 'monthly', recipients: { kind: 'all' } }, now)).not.toThrow();
  });

  it('changes nothing when it runs a second time', () => {
    expect(result.fresh.twice).toEqual(result.fresh.once);
  });
});

describe('launch defaults: values someone already set', () => {
  it('keeps every saved Limit and fills in only the ones that were empty', () => {
    expect(result.own.once.settings.meter).toMatchObject({ memberAllowanceMicros: 777_000, poolCeilingMicros: 4_000_000, atOnceMember: 2, appUseMicros: 1500 });
    expect(result.own.once.settings['instant-limits']).toMatchObject({ maxRunMicros: 99_000, sentWaitMinutes: 9, goodwillBudgetMicros: 5000 });
    // ...and the ones that were empty are filled in
    expect(result.own.once.settings.meter).toMatchObject({ reserveMicros: 500_000, storageMicrosPerGbMonth: 90_000, atOnceAll: 3 });
    expect(result.own.once.settings['instant-limits']).toMatchObject({ exposureCeilingMicros: 1_000_000, pauseFailureRateBps: 2000, pauseMinRuns: 10 });
  });

  it('keeps a rollout budget someone set to 0 (credit switched off on purpose)', () => {
    expect(readMeterSettings(result.own.once.settings.meter).rolloutBudgetMicros).toBe(0);
  });

  it('leaves an existing default alone, even one that gives nothing, and mirrors the saved allowance for computers', () => {
    expect(result.own.once.programs.map((p) => p.id)).toEqual(['own-instant', 'seed-default-computers']);
    expect(result.own.once.rules.find((rule) => rule.program_id === 'own-instant')).toMatchObject({ schedule: 'none', amount: '0' });
    expect(result.own.once.rules.find((rule) => rule.program_id === 'seed-default-computers')?.amount).toBe('777000');
  });

  it('changes nothing when it runs a second time', () => {
    expect(result.own.twice).toEqual(result.own.once);
  });
});

describe('launch defaults: a default someone ended and an allowance saved for a later day', () => {
  it('does not bring back a default that was ended, and does not put a second allowance beside the one saved for later', () => {
    expect(result.ended.once.programs.map((p) => [p.id, p.status])).toEqual([
      ['old-computers', 'ended'],
      ['seed-default-instant_apps', 'active'],
    ]);
    expect(result.ended.once.settings.meter).toHaveProperty('memberAllowanceLater');
    expect(result.ended.once.settings.meter).not.toHaveProperty('memberAllowanceMicros');
  });

  it('changes nothing when it runs a second time', () => {
    expect(result.ended.twice).toEqual(result.ended.once);
  });
});
