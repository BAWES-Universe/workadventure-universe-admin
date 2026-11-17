import { compareDay, UNBOOKED_SLACK_FRACTION, UNBOOKED_SLACK_MINUTES, dayBounds, daysToCheck } from '@/lib/computer-reconcile';
import type { ProviderDay, ProviderDayInstance } from '@/lib/computer-provider';

const RATE = 110; // micros per awake minute, only to put a price on a gap

const entry = (over: Partial<ProviderDayInstance> = {}): ProviderDayInstance => ({
  ref: 'm1',
  kind: 'brick',
  botId: 'bot-1',
  totalMicros: 1_000,
  computeMicros: 1_000,
  awakeMinutes: 0,
  expectedMicros: 1_000,
  ...over,
});
const bill = (...instances: ProviderDayInstance[]): ProviderDay => ({ day: '2026-11-15', totalMicros: instances.reduce((sum, one) => sum + one.totalMicros, 0), instances });
const books = (over: { machines?: Record<string, string>; minutes?: Record<string, number> } = {}) => ({
  machines: new Map(Object.entries(over.machines ?? { m1: 'bot-1' })),
  minutesByBot: new Map(Object.entries(over.minutes ?? {})),
});

describe("the daily check of our books against the provider's bill", () => {
  it('says nothing is wrong when what the machine was awake is what we booked, and what it cost is what the published rates make of it', () => {
    const result = compareDay(bill(entry({ awakeMinutes: 60, computeMicros: 7_000, totalMicros: 7_000, expectedMicros: 7_000 })), books({ minutes: { 'bot-1': 60 } }), RATE);
    expect(result.findings).toEqual([]);
    expect(result).toMatchObject({ ourMinutes: 60, agentMinutes: 60, gapMicros: 0, agentBrickMicros: 7_000 });
  });

  it('finds time the provider billed that no job booked: a machine that was awake with nobody working on it', () => {
    const result = compareDay(bill(entry({ awakeMinutes: 300, expectedMicros: 1_000 })), books({ minutes: { 'bot-1': 30 } }), RATE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: 'unbooked_time', ref: 'm1', botId: 'bot-1', theirs: 300, ours: 30 });
    // What is over the room a job's own start and stop may leave, priced at an awake minute
    const allowed = 30 * (1 + UNBOOKED_SLACK_FRACTION) + UNBOOKED_SLACK_MINUTES;
    expect(result.findings[0].gapMicros).toBe(Math.round((300 - allowed) * RATE));
  });

  it('leaves the room a start and a stop need: a few minutes awake with no job is not a finding', () => {
    expect(compareDay(bill(entry({ awakeMinutes: UNBOOKED_SLACK_MINUTES })), books(), RATE).findings).toEqual([]);
    expect(compareDay(bill(entry({ awakeMinutes: UNBOOKED_SLACK_MINUTES + 1 })), books(), RATE).findings).toHaveLength(1);
  });

  it('never calls booking more than the provider billed a finding: that errs on the safe side', () => {
    expect(compareDay(bill(entry({ awakeMinutes: 10 })), books({ minutes: { 'bot-1': 400 } }), RATE).findings).toEqual([]);
  });

  it('finds spend on managed services (the model, search, apps) on a Brick machine: the managed budget is $0 and nothing should be there', () => {
    const result = compareDay(bill(entry({ totalMicros: 1_900, computeMicros: 1_000 })), books(), RATE);
    expect(result.findings).toEqual([{ kind: 'managed_spend', ref: 'm1', botId: 'bot-1', theirs: 900, ours: 0, gapMicros: 900 }]);
  });

  it('finds a Brick machine the provider bills that none of our records points to: a machine we lost track of', () => {
    const result = compareDay(bill(entry({ ref: 'lost1', botId: 'bot-9', totalMicros: 5_000, computeMicros: 5_000 })), books({ machines: {} }), RATE);
    expect(result.findings).toEqual([{ kind: 'unknown_machine', ref: 'lost1', botId: 'bot-9', theirs: 5_000, ours: 0, gapMicros: 5_000 }]);
  });

  it('finds a machine whose record points at another Brick than the one we wrote on it', () => {
    const result = compareDay(bill(entry({ botId: 'bot-2' })), books({ machines: { m1: 'bot-1' } }), RATE);
    expect(result.findings.map((finding) => finding.kind)).toEqual(['unknown_machine']);
  });

  it('counts machines that are not Bricks and machines that are gone in the total, and never calls them a finding', () => {
    const result = compareDay(bill(entry({ ref: 'x', kind: 'other', botId: null, totalMicros: 4_000, computeMicros: 4_000, awakeMinutes: 900 }), entry({ ref: 'y', kind: 'gone', botId: null, awakeMinutes: 900 })), books({ machines: {} }), RATE);
    expect(result.findings).toEqual([]);
    expect(result.agentBrickMicros).toBe(0);
  });

  it('finds a bill higher than the published rates make of the awake minutes, and not one that is lower (a machine made or removed that day)', () => {
    const higher = compareDay(bill(entry({ awakeMinutes: 60, computeMicros: 20_000, totalMicros: 20_000, expectedMicros: 7_000 })), books({ minutes: { 'bot-1': 60 } }), RATE);
    expect(higher.findings).toMatchObject([{ kind: 'rate_gap', ref: 'm1', gapMicros: 13_000 }]);
    const lower = compareDay(bill(entry({ awakeMinutes: 60, computeMicros: 3_000, totalMicros: 3_000, expectedMicros: 7_000 })), books({ minutes: { 'bot-1': 60 } }), RATE);
    expect(lower.findings).toEqual([]);
    const unsaid = compareDay(bill(entry({ awakeMinutes: 60, expectedMicros: null })), books({ minutes: { 'bot-1': 60 } }), RATE);
    expect(unsaid.findings).toEqual([]);
  });

  it('adds up what the findings come to', () => {
    const result = compareDay(bill(entry({ totalMicros: 1_900, computeMicros: 1_000 }), entry({ ref: 'lost1', botId: 'bot-9', totalMicros: 5_000, computeMicros: 5_000 })), books(), RATE);
    expect(result.gapMicros).toBe(900 + 5_000);
  });
});

describe('which days are checked', () => {
  it('is one UTC day, from its midnight to the next', () => {
    expect(dayBounds('2026-11-15')).toEqual({ from: new Date('2026-11-15T00:00:00Z'), to: new Date('2026-11-16T00:00:00Z') });
  });

  it('is the last day that ended an hour ago or more, and a first run checks only that one', () => {
    expect(daysToCheck(new Date('2026-11-16T00:30:00Z'), null)).toEqual(['2026-11-14']);
    expect(daysToCheck(new Date('2026-11-16T01:00:00Z'), null)).toEqual(['2026-11-15']);
    expect(daysToCheck(new Date('2026-11-16T00:30:00Z'), '2026-11-14')).toEqual([]);
  });

  it('goes on from the last day checked, oldest first, and never more than a week at a time', () => {
    expect(daysToCheck(new Date('2026-11-16T05:00:00Z'), '2026-11-15')).toEqual([]);
    expect(daysToCheck(new Date('2026-11-16T05:00:00Z'), '2026-11-13')).toEqual(['2026-11-14', '2026-11-15']);
    expect(daysToCheck(new Date('2026-11-30T05:00:00Z'), '2026-11-01')).toHaveLength(7);
    expect(daysToCheck(new Date('2026-11-30T05:00:00Z'), '2026-11-01')[0]).toBe('2026-11-02');
  });
});
