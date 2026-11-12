/**
 * The meter's rules (game #1998, Brick 7) without a database: what an event must say, how sure a cost is, the settings, and what
 * a member has left of their month with extra usage on top.
 */
import {
  METER_RANGES,
  allowanceNow,
  basisOfCall,
  checkMeterSettings,
  extraDrawn,
  missingSettings,
  monthOf,
  nextMonthStart,
  personKeyOf,
  readMeterEvent,
  readMeterSettings,
  usageWords,
  type GrantWindow,
} from '@/lib/meter-values';
import { pickRunning } from '@/lib/meter-grants';

const event = (over: object = {}) => ({
  eventId: 'e1',
  kind: 'app_use',
  personKey: 'person:sara',
  payerKind: 'universe',
  basis: 'estimated',
  quantity: 1,
  unit: 'use',
  costMicros: 300,
  ...over,
});

describe('an event the books keep', () => {
  it('needs an id, a person, a payer, a unit and a mark for how sure its figure is', () => {
    expect(readMeterEvent(event()).ok).toBe(true);
    for (const missing of ['eventId', 'kind', 'personKey', 'payerKind', 'basis', 'unit', 'quantity']) {
      const input: Record<string, unknown> = event();
      delete input[missing];
      expect(readMeterEvent(input).ok).toBe(false);
    }
  });

  it('marks every figure measured, estimated, paid by someone else or unknown, and nothing else', () => {
    for (const basis of ['measured', 'estimated', 'paid_by_other', 'unknown']) expect(readMeterEvent(event({ basis })).ok).toBe(true);
    expect(readMeterEvent(event({ basis: 'probably' }))).toEqual({ ok: false, error: expect.stringContaining('basis must be one of') });
  });

  it('never calls a figure measured when there is no figure, and never turns an unknown price into 0', () => {
    expect(readMeterEvent(event({ basis: 'measured', costMicros: null })).ok).toBe(false);
    const unknown = readMeterEvent(event({ basis: 'unknown', costMicros: null }));
    expect(unknown.ok && unknown.value.costMicros).toBeNull();
    const zero = readMeterEvent(event({ basis: 'measured', costMicros: 0 }));
    expect(zero.ok && zero.value.costMicros).toBe(0);
  });

  it('takes whole numbers only, never negative', () => {
    expect(readMeterEvent(event({ quantity: -1 })).ok).toBe(false);
    expect(readMeterEvent(event({ quantity: 1.5 })).ok).toBe(false);
    expect(readMeterEvent(event({ costMicros: -5 })).ok).toBe(false);
    expect(readMeterEvent(event({ costMicros: 0.5 })).ok).toBe(false);
    expect(readMeterEvent(event({ quantity: '3' })).ok).toBe(false);
  });

  it('says who it was for in the same words the reply windows use, or "unknown", and nothing else', () => {
    expect(personKeyOf({ personId: 'p1' })).toBe('person:p1');
    expect(personKeyOf({ guestId: 'g1' })).toBe('guest:g1');
    expect(personKeyOf({})).toBe('unknown');
    expect(readMeterEvent(event({ personKey: 'unknown' })).ok).toBe(true);
    expect(readMeterEvent(event({ personKey: 'sara' })).ok).toBe(false);
  });

  it('puts chat and computer work in their own pools and never lets computer work be paid from chat’s', () => {
    expect(readMeterEvent(event({ kind: 'model_call' }))).toMatchObject({ ok: true, value: { pool: 'chat' } });
    expect(readMeterEvent(event({ kind: 'computer_time', unit: 'minute' }))).toMatchObject({ ok: true, value: { pool: 'computer' } });
    expect(readMeterEvent(event({ kind: 'stored_bytes', unit: 'byte', pool: 'chat' })).ok).toBe(false);
    // A tool a computer job used is the computer's; one a reply used is chat's
    expect(readMeterEvent(event({ pool: 'computer', jobId: 'job-1' }))).toMatchObject({ ok: true, value: { pool: 'computer', jobId: 'job-1' } });
  });

  it('keeps no more detail than a person could read later', () => {
    expect(readMeterEvent(event({ detail: { tokens: 5 } })).ok).toBe(true);
    expect(readMeterEvent(event({ detail: 'a long chat message' })).ok).toBe(false);
    expect(readMeterEvent(event({ detail: { text: 'x'.repeat(5000) } })).ok).toBe(false);
  });

  it('refuses a date that is not one', () => {
    expect(readMeterEvent(event({ occurredAt: 'tomorrow-ish' })).ok).toBe(false);
  });
});

describe('how sure a model call’s cost is', () => {
  it('is measured when the provider said it, estimated from a price list or our own rate, unknown without a price', () => {
    expect(basisOfCall('provider', false, 10)).toBe('measured');
    expect(basisOfCall('own_computer', false, 0)).toBe('measured');
    expect(basisOfCall('priced', false, 10)).toBe('estimated');
    expect(basisOfCall('override', false, 10)).toBe('estimated');
    expect(basisOfCall('unknown', false, null)).toBe('unknown');
    expect(basisOfCall(null, false, null)).toBe('unknown');
    expect(basisOfCall('priced', false, null)).toBe('unknown');
  });

  it('is someone else’s bill when their key paid, whatever it cost', () => {
    expect(basisOfCall('provider', true, 10)).toBe('paid_by_other');
    expect(basisOfCall(null, true, null)).toBe('paid_by_other');
  });
});

describe('the month', () => {
  it('is a calendar month in UTC for everyone', () => {
    expect(monthOf(new Date('2026-11-30T23:59:59Z'))).toEqual({ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') });
    expect(monthOf(new Date('2026-12-31T12:00:00Z')).end).toEqual(new Date('2027-01-01T00:00:00Z'));
  });
});

describe('the meter’s settings', () => {
  it('start empty: no number is made up, and only the renew time has a recommended value', () => {
    const settings = readMeterSettings(null);
    expect(settings).toEqual({ memberAllowanceMicros: null, poolCeilingMicros: null, reserveMicros: null, storageMicrosPerGbMonth: null, atOnceMember: null, atOnceAll: null, renewMinutes: 10 });
    expect(missingSettings(settings)).toEqual(['memberAllowanceMicros', 'poolCeilingMicros', 'reserveMicros', 'storageMicrosPerGbMonth', 'atOnceMember', 'atOnceAll']);
  });

  it('reads back what fits and ignores what does not', () => {
    const settings = readMeterSettings({ memberAllowanceMicros: 5_000_000, atOnceMember: 0, reserveMicros: 'lots', renewMinutes: 15, other: 1 });
    expect(settings).toMatchObject({ memberAllowanceMicros: 5_000_000, atOnceMember: null, reserveMicros: null, renewMinutes: 15 });
    expect(missingSettings({ ...settings, poolCeilingMicros: 1, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 1, atOnceAll: 1 })).toEqual([]);
  });

  it('checks a change: only its own names, each inside its range, and null empties one again', () => {
    expect(checkMeterSettings({ poolCeilingMicros: 90_000_000, renewMinutes: 5 })).toEqual({ ok: true, value: { poolCeilingMicros: 90_000_000, renewMinutes: 5 } });
    expect(checkMeterSettings({ memberAllowanceMicros: null })).toEqual({ ok: true, value: { memberAllowanceMicros: null } });
    expect(checkMeterSettings({ renewMinutes: null }).ok).toBe(false);
    expect(checkMeterSettings({ atOnceMember: 0 }).ok).toBe(false);
    expect(checkMeterSettings({ atOnceMember: 1.5 }).ok).toBe(false);
    expect(checkMeterSettings({ renewMinutes: METER_RANGES.renewMinutes.max + 1 }).ok).toBe(false);
    expect(checkMeterSettings({ constructor: 1 })).toEqual({ ok: false, error: 'Unknown setting: constructor' });
    expect(checkMeterSettings([]).ok).toBe(false);
  });
});

describe('what a member has left of their month', () => {
  const BASE = 1000;
  const now = new Date('2026-11-15T12:00:00Z');
  const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T12:00:00Z`);
  const double: GrantWindow = { startsAt: at(10), endsAt: at(20), multiplier: 2 };

  it('is the usual allowance less what was spent', () => {
    expect(allowanceNow(BASE, [{ at: at(2), micros: 400 }], [], now)).toEqual({ unlimited: false, usedMicros: 400, leftMicros: 600 });
    expect(allowanceNow(BASE, [{ at: at(2), micros: 1500 }], [], now).leftMicros).toBe(0);
  });

  it('adds the usual again for double, while it lasts', () => {
    expect(allowanceNow(BASE, [{ at: at(2), micros: 400 }], [double], now).leftMicros).toBe(1600);
  });

  it('is never a multiple of a multiple: the largest running at a moment counts, and a second grant beside it adds nothing', () => {
    const five: GrantWindow = { startsAt: at(12), endsAt: at(18), multiplier: 5 };
    expect(allowanceNow(BASE, [], [double, five], now).leftMicros).toBe(5000);
    const twoAndTwo: GrantWindow = { startsAt: at(11), endsAt: at(19), multiplier: 2 };
    expect(allowanceNow(BASE, [], [double, twoAndTwo], now).leftMicros).toBe(2000);
  });

  it('is used before the usual allowance, so when it ends only the extra goes', () => {
    // 500 spent while double ran: all of it came out of the extra, so after it ends the whole usual allowance is still there
    const spends = [{ at: at(12), micros: 500 }];
    expect(allowanceNow(BASE, spends, [double], at(15)).leftMicros).toBe(1500);
    expect(allowanceNow(BASE, spends, [double], at(21)).leftMicros).toBe(1000);
    // 1300 spent while double ran: 1000 of extra, then 300 of the usual
    expect(allowanceNow(BASE, [{ at: at(12), micros: 1300 }], [double], at(21)).leftMicros).toBe(700);
  });

  it('keeps what was spent before the extra began against the usual allowance', () => {
    expect(allowanceNow(BASE, [{ at: at(3), micros: 900 }], [double], at(21)).leftMicros).toBe(100);
    expect(allowanceNow(BASE, [{ at: at(3), micros: 900 }], [double], now).leftMicros).toBe(1100);
  });

  it('lifts the member’s own limit with no limit, for as long as it lasts, and not a moment longer', () => {
    const none: GrantWindow = { startsAt: at(10), endsAt: at(20), multiplier: null };
    expect(allowanceNow(BASE, [{ at: at(12), micros: 9_999 }], [none], now)).toEqual({ unlimited: true, usedMicros: 9_999, leftMicros: null });
    // What went through while it lasted was not the usual allowance's
    expect(allowanceNow(BASE, [{ at: at(12), micros: 9_999 }], [none], at(21))).toEqual({ unlimited: false, usedMicros: 9_999, leftMicros: 1000 });
  });

  it('does not depend on the order spends are given in', () => {
    const spends = [
      { at: at(14), micros: 300 },
      { at: at(11), micros: 800 },
    ];
    expect(allowanceNow(BASE, spends, [double], at(21))).toEqual(allowanceNow(BASE, [...spends].reverse(), [double], at(21)));
  });
});

describe('what extra usage has cost above the usual (game #1999)', () => {
  const BASE = 1000;
  const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T12:00:00Z`);
  const double: GrantWindow = { startsAt: at(10), endsAt: at(20), multiplier: 2 };
  const none: GrantWindow = { startsAt: at(10), endsAt: at(20), multiplier: null };

  it('is what was spent while it ran, up to what it added, and nothing before it started or after it ended', () => {
    const spends = [
      { at: at(2), micros: 300 },
      { at: at(12), micros: 400 },
      { at: at(25), micros: 900 },
    ];
    expect(extraDrawn(BASE, spends, [double])).toEqual([400]);
  });

  it('stops at what it added: double adds one more usual, so a bigger spend is the usual allowance’s', () => {
    expect(extraDrawn(BASE, [{ at: at(12), micros: 1700 }], [double])).toEqual([1000]);
  });

  it('counts everything spent while no limit ran', () => {
    expect(extraDrawn(BASE, [{ at: at(12), micros: 5000 }], [none])).toEqual([5000]);
  });

  it('gives each extra usage its own figure, in the order given, and the larger one running takes the spend', () => {
    const five: GrantWindow = { startsAt: at(10), endsAt: at(20), multiplier: 5 };
    expect(extraDrawn(BASE, [{ at: at(12), micros: 600 }], [double, five])).toEqual([0, 600]);
  });

  it('is nothing when none was given or nothing was spent', () => {
    expect(extraDrawn(BASE, [{ at: at(12), micros: 600 }], [])).toEqual([]);
    expect(extraDrawn(BASE, [], [double])).toEqual([0]);
  });
});

describe('which of two equal extra usages is drawn first (game #1999)', () => {
  const BASE = 1000;
  const now = new Date('2026-11-15T12:00:00Z');
  const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T12:00:00Z`);
  const spends = [{ at: at(12), micros: 600 }];
  const a: GrantWindow = { key: 'k-a', startsAt: at(10), endsAt: at(20), multiplier: 2 };
  const b: GrantWindow = { key: 'k-b', startsAt: at(10), endsAt: at(20), multiplier: 2 };

  /** What each key drew, whatever order the grants were read in. */
  const drawnByKey = (grants: GrantWindow[]) => Object.fromEntries(grants.map((grant, index) => [grant.key, extraDrawn(BASE, spends, grants)[index]]));

  it('is the smaller key when size, end and start are all the same, whatever the order the rows came in', () => {
    expect(drawnByKey([a, b])).toEqual({ 'k-a': 600, 'k-b': 0 });
    expect(drawnByKey([b, a])).toEqual({ 'k-a': 600, 'k-b': 0 });
  });

  it('is the grant the person page shows for it: the same key pickRunning picks, in either order', () => {
    const rows = [a, b].map((grant) => ({ grantKey: grant.key as string, multiplier: grant.multiplier, noLimit: false, endsAt: grant.endsAt }));
    for (const order of [rows, [...rows].reverse()]) {
      const shown = pickRunning(order)?.grantKey;
      const drawn = drawnByKey(order.map((row) => (row.grantKey === 'k-a' ? a : b)));
      expect(Object.keys(drawn).find((key) => drawn[key] > 0)).toBe(shown);
    }
  });

  it('leaves the member the same amount whichever order, so the allowance and the Costs page agree', () => {
    expect(allowanceNow(BASE, spends, [a, b], now)).toEqual(allowanceNow(BASE, spends, [b, a], now));
  });

  it('is the one that ends sooner, then the one that started first, before the key decides', () => {
    const soonerButLaterKey: GrantWindow = { key: 'k-z', startsAt: at(10), endsAt: at(18), multiplier: 2 };
    expect(drawnByKey([a, soonerButLaterKey])).toEqual({ 'k-a': 0, 'k-z': 600 });
    const earlierStartLaterKey: GrantWindow = { key: 'k-z', startsAt: at(9), endsAt: at(20), multiplier: 2 };
    expect(drawnByKey([a, earlierStartLaterKey])).toEqual({ 'k-a': 0, 'k-z': 600 });
    expect(drawnByKey([earlierStartLaterKey, a])).toEqual({ 'k-a': 0, 'k-z': 600 });
  });
});

describe('the words under a usage bar (game #1999)', () => {
  it('says out at nothing, low at a fifth or less, and over half above half', () => {
    expect(usageWords(0)).toBe('out');
    expect(usageWords(0.01)).toBe('low');
    expect(usageWords(0.2)).toBe('low');
    expect(usageWords(0.21)).toBe('half');
    expect(usageWords(0.5)).toBe('half');
    expect(usageWords(0.51)).toBe('plenty');
    expect(usageWords(1)).toBe('plenty');
  });

  it('says a month starts again on the first of the next one, in UTC, across a year end too', () => {
    expect(nextMonthStart(new Date('2026-11-15T12:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextMonthStart(new Date('2026-12-31T23:59:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
