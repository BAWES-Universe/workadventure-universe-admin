import {
  INSTANT_LIMITS_EMPTY,
  INSTANT_NEEDED,
  admitInstantTool,
  instantAllowedArguments,
  argsFingerprint,
  checkInstantLimits,
  customerChargeFor,
  instantAppOf,
  instantCallFeeMicros,
  INSTANT_APPS,
  holdFor,
  instantCatalog,
  missingInstantLimits,
  providerUserIdFor,
  readInstantCharge,
  readInstantLimits,
  usdToMicros,
} from '@/lib/instant/values';
import { DIRECT_EXECUTION_MICROS, RATE_MICROS } from '@/lib/composio-rates';

describe('a tool is offered only when its arguments can be held to a top price', () => {
  it('holds a flat-price tool at Composio price plus the call fee and the direct execution add-on', () => {
    const admitted = admitInstantTool('EXA_SEARCH', { query: 'weather' });
    expect(admitted).toMatchObject({ ok: true, toolkit: 'exa', units: 1 });
    // $0.007 Instant price + $0.0005 managed call fee + $0.0001 direct execution
    expect(admitted.ok && admitted.topMicros).toBe(7_000 + RATE_MICROS.managed_other + DIRECT_EXECUTION_MICROS);
  });

  it('refuses a tool that is not in the trusted table, however it is spelled', () => {
    for (const tool of ['SOMETHING_ELSE', 'exa_search', 'EXA_SEARCH ', '__proto__', 'constructor', 'toString', '']) {
      expect(admitInstantTool(tool, { query: 'x' })).toEqual({ ok: false, reason: 'not_offered' });
    }
  });

  it('refuses arguments that cannot be held to a number: never guessed', () => {
    expect(admitInstantTool('EXA_SEARCH', {})).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_SEARCH', { query: '' })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_SEARCH', { query: 'x'.repeat(2_001) })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_SEARCH', null)).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_SEARCH', [])).toEqual({ ok: false, reason: 'unbounded' });
  });

  it('prices a per-page tool by pages times content types, and refuses an argument not known to be free', () => {
    const one = admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'] });
    const six = admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example', 'https://b.example'], text: true, highlights: true, summary: true });
    expect(one.ok && one.units).toBe(1);
    expect(six.ok && six.units).toBe(6);
    expect(six.ok && one.ok && six.topMicros - one.topMicros).toBe(5_000);
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], subpages: 50 })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: [] })).toEqual({ ok: false, reason: 'unbounded' });
    // An option that is not a flag or a small object, or a timeout that is not a number, is not an argument the price was read for
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], summary: { query: 'x'.repeat(3_000) } })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], livecrawl_timeout: '9999' })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], text: 'yes' })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], summary: { query: 'what is it' }, livecrawl: 'fallback', livecrawl_timeout: 5000 })).toMatchObject({ ok: true });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: Array.from({ length: 21 }, (_, i) => `https://x${i}.example`) })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', {})).toEqual({ ok: false, reason: 'unbounded' });
  });

  it('counts pages from urls and ids together, and refuses a list that is not a list', () => {
    const both = admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], ids: ['b', 'c'] });
    const idsOnly = admitInstantTool('EXA_GET_CONTENTS_ACTION', { ids: ['b', 'c'] });
    expect(both.ok && both.units).toBe(3);
    expect(idsOnly.ok && idsOnly.units).toBe(2);
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: ['https://a.example'], ids: 'b' })).toEqual({ ok: false, reason: 'unbounded' });
    expect(admitInstantTool('EXA_GET_CONTENTS_ACTION', { urls: Array.from({ length: 12 }, (_, i) => `https://x${i}.example`), ids: Array.from({ length: 12 }, (_, i) => `i${i}`) })).toEqual({ ok: false, reason: 'unbounded' });
  });

  it('offers no tool whose rate card price is only a floor (Google Maps is "from $0.01")', () => {
    expect(admitInstantTool('GOOGLE_MAPS_GEOCODE_PLACE', { place_id: 'ChIJj61dQgK6j4AR4GeTYWZsKWw' })).toEqual({ ok: false, reason: 'not_offered' });
    expect(instantCatalog().some((row) => row.toolkit === 'google_maps')).toBe(false);
  });

  it('holds every offered tool at its unit price plus the settled call fee', () => {
    const admitted = admitInstantTool('EXA_SEARCH', { query: 'x' });
    expect(admitted.ok && admitted.topMicros).toBe(7_000 + RATE_MICROS.managed_other + DIRECT_EXECUTION_MICROS);
  });

  it('lists only tools with a price above zero', () => {
    const catalog = instantCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const row of catalog) expect(row.fromMicros).toBeGreaterThan(0);
  });
});

describe('money is exact', () => {
  it('reads dollars to micros and never reads a charge as less than it was', () => {
    expect(usdToMicros('0.007')).toBe(7_000);
    expect(usdToMicros('$0.00283')).toBe(2_830);
    expect(usdToMicros(0.007)).toBe(7_000);
    expect(usdToMicros('1')).toBe(1_000_000);
    expect(usdToMicros('0.0000001')).toBe(1);
    expect(usdToMicros('0.0000011')).toBe(2);
    expect(usdToMicros('0')).toBe(0);
  });

  it('never rounds before rounding up: a figure a hair over a micro is the next micro, and a tiny positive one is not zero', () => {
    expect(usdToMicros(0.0000010000001)).toBe(2);
    expect(usdToMicros('0.0000010000001')).toBe(2);
    expect(usdToMicros('0.0000010000000000000001')).toBe(2);
    expect(usdToMicros(1e-13)).toBe(1);
    expect(usdToMicros(1e-7)).toBe(1);
    expect(usdToMicros(2e-6)).toBe(2);
    expect(usdToMicros(1.5e3)).toBe(1_500_000_000);
    expect(usdToMicros(0.000001)).toBe(1);
    expect(usdToMicros(0)).toBe(0);
  });

  it('refuses what is not a plain non-negative decimal', () => {
    for (const bad of ['-1', '1e3', 'abc', '', '1,5', ' ', '1.', '.5', NaN, -0.1, Infinity, null, undefined, {}, '99999999999999']) expect(usdToMicros(bad)).toBeNull();
  });

  it('reads a charge from the shapes Composio uses, and never turns a missing one into zero', () => {
    expect(readInstantCharge({ amount: '0.007', currency: 'USD' })).toBe(7_000);
    expect(readInstantCharge({ amount: 0.0021 })).toBe(2_100);
    expect(readInstantCharge('0.003')).toBe(3_000);
    expect(readInstantCharge(0)).toBe(0);
    expect(readInstantCharge({ amount: '0.007', currency: 'EUR' })).toBeNull();
    expect(readInstantCharge({ currency: 978, amount: '0.01' })).toBeNull();
    expect(readInstantCharge({ currency_code: 840, amount: '0.01' })).toBeNull();
    expect(readInstantCharge({ amount: '0.01', currency: ' usd ' })).toBe(10_000);
    expect(readInstantCharge({})).toBeNull();
    expect(readInstantCharge(undefined)).toBeNull();
    expect(readInstantCharge(null)).toBeNull();
    expect(readInstantCharge({ amount: 'lots' })).toBeNull();
  });

  it('holds the top price with the markup a super admin set, rounded up, and charges the person never more than the hold', () => {
    expect(holdFor(7_600, null)).toBe(7_600);
    expect(holdFor(7_600, 0)).toBe(7_600);
    expect(holdFor(7_600, 1_000)).toBe(8_360);
    expect(holdFor(7_601, 1_000)).toBe(8_362);
    // The person pays Composio's charge plus its call fee ($0.0006): the fee is counted against their own credit (money call of 26 Nov 2026)
    expect(instantCallFeeMicros()).toBe(RATE_MICROS.managed_other + DIRECT_EXECUTION_MICROS);
    expect(instantCallFeeMicros()).toBe(600);
    expect(customerChargeFor(7_000, 7_600, null)).toBe(7_600);
    expect(customerChargeFor(6_500, 7_600, null)).toBe(7_100);
    expect(customerChargeFor(7_000, 8_360, 1_000)).toBe(8_360);
    // A charge above the top price: the person pays the hold at most, the rest is ours
    expect(customerChargeFor(50_000, 7_600, null)).toBe(7_600);
    // A free run (the App charged nothing) still takes the fee from the person's credit, never more than the hold
    expect(customerChargeFor(0, 7_600, null)).toBe(600);
    expect(customerChargeFor(0, 300, null)).toBe(300);
  });

  it('every tool of the table belongs to a research App with a name and one line, and the name never says who runs it', () => {
    for (const row of instantCatalog()) {
      const app = instantAppOf(row.toolkit);
      expect(app).not.toBeNull();
      expect(app?.name).toMatch(/^\S/);
      expect(app?.strength.length).toBeGreaterThan(5);
      expect(`${app?.name} ${app?.strength}`).not.toMatch(/composio/i);
    }
    expect(Object.keys(INSTANT_APPS).sort()).toEqual([...new Set(instantCatalog().map((row) => row.toolkit))].sort());
    expect(instantAppOf('constructor')).toBeNull();
    expect(instantAppOf('gmail')).toBeNull();
  });

  it('the most runs one question may have is an optional count: empty is no bound, never required for Instant to run', () => {
    expect(INSTANT_LIMITS_EMPTY.maxRunsPerQuestion).toBeNull();
    expect(INSTANT_NEEDED).not.toContain('maxRunsPerQuestion');
    expect(checkInstantLimits({ maxRunsPerQuestion: 8 })).toEqual({ ok: true, value: { maxRunsPerQuestion: 8 } });
    expect(checkInstantLimits({ maxRunsPerQuestion: null })).toEqual({ ok: true, value: { maxRunsPerQuestion: null } });
    expect(checkInstantLimits({ maxRunsPerQuestion: 0 }).ok).toBe(false);
    expect(checkInstantLimits({ maxRunsPerQuestion: 2.5 }).ok).toBe(false);
  });

  it('fingerprints what was asked the same however the keys are ordered, and tells different asks apart', () => {
    expect(argsFingerprint('EXA_SEARCH', { a: 1, b: { c: 2, d: 3 } })).toBe(argsFingerprint('EXA_SEARCH', { b: { d: 3, c: 2 }, a: 1 }));
    expect(argsFingerprint('EXA_SEARCH', { a: 1 })).not.toBe(argsFingerprint('EXA_SEARCH', { a: 2 }));
    expect(argsFingerprint('EXA_SEARCH', { a: 1 })).not.toBe(argsFingerprint('EXA_ANSWER', { a: 1 }));
  });

  it('sends a run under an id that is nothing of a person', () => {
    expect(providerUserIdFor('run-1')).toBe('universe-instant-run-1');
  });
});

describe('a run may carry only arguments known to stay inside its priced unit', () => {
  it('lets the plain forms of each tool through, and bounded extras', () => {
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', numResults: 10, includeDomains: ['a.example'] })).toMatchObject({ ok: true, units: 1 });
    expect(admitInstantTool('EXA_ANSWER', { query: 'x', model: 'exa' })).toMatchObject({ ok: true });
    expect(admitInstantTool('TAVILY_SEARCH', { query: 'x', max_results: 5, search_depth: 'basic' })).toMatchObject({ ok: true });
  });

  it('refuses any argument that could raise the cost: more results, deeper search, contents, a pro model, a stream', () => {
    const refused = { ok: false, reason: 'unbounded' };
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', numResults: 100 })).toEqual(refused);
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', numResults: 11 })).toEqual(refused);
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', contents: { text: true } })).toEqual(refused);
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', type: 'deep' })).toEqual(refused);
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', additionalQueries: ['a', 'b'] })).toEqual(refused);
    expect(admitInstantTool('EXA_ANSWER', { query: 'x', model: 'exa-pro' })).toEqual(refused);
    expect(admitInstantTool('EXA_ANSWER', { query: 'x', text: true })).toEqual(refused);
    expect(admitInstantTool('EXA_ANSWER', { query: 'x', stream: true })).toEqual(refused);
    expect(admitInstantTool('TAVILY_SEARCH', { query: 'x', search_depth: 'advanced' })).toEqual(refused);
    expect(admitInstantTool('TAVILY_SEARCH', { query: 'x', max_results: 50 })).toEqual(refused);
    expect(admitInstantTool('TAVILY_SEARCH', { query: 'x', include_raw_content: true })).toEqual(refused);
  });

  it('refuses a call missing what the tool needs, and a number that is not a number', () => {
    const refused = { ok: false, reason: 'unbounded' };
    expect(admitInstantTool('EXA_SEARCH', {})).toEqual(refused);
    expect(admitInstantTool('TAVILY_SEARCH', { query: 5 })).toEqual(refused);
    expect(admitInstantTool('EXA_SEARCH', { query: 'x', numResults: 2.5 })).toEqual(refused);
  });

  it('names the arguments a Brick may use, for cutting the schema it is offered', () => {
    expect(instantAllowedArguments('TAVILY_SEARCH')?.names).not.toContain('include_raw_content');
    expect(instantAllowedArguments('EXA_SEARCH')?.names).not.toContain('contents');
    expect(instantAllowedArguments('EXA_SEARCH')?.required).toEqual(['query']);
    expect(instantAllowedArguments('NOT_A_TOOL')).toBeNull();
  });
});

describe('Instant refuses to open until the limits that bound it are set', () => {
  it('starts with no money or count set: nothing is assumed', () => {
    expect(missingInstantLimits(INSTANT_LIMITS_EMPTY).sort()).toEqual([...INSTANT_NEEDED].sort());
    for (const key of INSTANT_NEEDED) expect(INSTANT_LIMITS_EMPTY[key]).toBeNull();
    expect(INSTANT_LIMITS_EMPTY.goodwillBudgetMicros).toBeNull();
    expect(INSTANT_LIMITS_EMPTY.markupBps).toBeNull();
  });

  it('an unclear wait shorter than a request to Composio may take is refused', () => {
    expect(checkInstantLimits({ unclearWaitMinutes: 1 })).toMatchObject({ ok: false });
    expect(checkInstantLimits({ unclearWaitMinutes: 2 })).toMatchObject({ ok: true });
  });

  it('reads saved values that fit and ignores the rest', () => {
    const limits = readInstantLimits({ maxRunMicros: 50_000, exposureCeilingMicros: 'lots', pauseFailureRateBps: 0, pauseMinRuns: 20, extra: 1, sentWaitMinutes: 9 });
    expect(limits.maxRunMicros).toBe(50_000);
    expect(limits.exposureCeilingMicros).toBeNull();
    expect(limits.pauseFailureRateBps).toBeNull();
    expect(limits.pauseMinRuns).toBe(20);
    expect(limits.sentWaitMinutes).toBe(9);
  });

  it('checks a change: known names only, inside their range, and null empties a money or count one but never a time', () => {
    expect(checkInstantLimits({ maxRunMicros: 50_000 })).toEqual({ ok: true, value: { maxRunMicros: 50_000 } });
    expect(checkInstantLimits({ maxRunMicros: null })).toEqual({ ok: true, value: { maxRunMicros: null } });
    expect(checkInstantLimits({ sentWaitMinutes: null }).ok).toBe(false);
    expect(checkInstantLimits({ maxRunMicros: 0 }).ok).toBe(false);
    expect(checkInstantLimits({ maxRunMicros: 1.5 }).ok).toBe(false);
    expect(checkInstantLimits({ nope: 1 }).ok).toBe(false);
    expect(checkInstantLimits([]).ok).toBe(false);
  });
});
