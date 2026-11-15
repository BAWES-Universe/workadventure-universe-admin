/**
 * The funding books' pure rules (paying spec v3, section 16, O1): who a grant reaches, which rule wins, what a charge is, what a lot
 * issues, and the order credit is spent in. What needs the database (once per period under many writers, holds under locks) is in
 * credit-books-db.test.ts.
 */
import {
  CreditRefused,
  allocate,
  baseRank,
  categoryFor,
  claimOpen,
  classifyCharge,
  findClashes,
  monthKey,
  pickBase,
  planLot,
  reaches,
  readRecipient,
  recipientColumns,
  slotKeyFor,
  spendOrder,
  subjectKeyFor,
  type LotFacts,
  type PersonFacts,
  type Recipient,
  type RuleFacts,
} from '@/lib/credit-values';

const D = (iso: string) => new Date(iso);

const person = (id: string, createdAt = '2026-06-01T00:00:00Z', universes: string[] = []): PersonFacts => ({ id, createdAt: D(createdAt), universeIds: new Set(universes) });

let n = 0;
const rule = (over: Partial<RuleFacts> & { recipient?: Recipient } = {}): RuleFacts => ({
  id: `r${++n}`,
  programId: `p${n}`,
  programKind: 'default',
  categoryId: 'instant_apps',
  version: 1,
  fundingAccountId: 'funding-platform',
  covers: ['instant_apps'],
  benefitKind: 'replace',
  amount: 2_000_000,
  schedule: 'once',
  share: 'each',
  recipient: { kind: 'all' },
  recipientIds: new Set(),
  joinerCap: null,
  totalCapMicros: null,
  claimStartsAt: D('2026-01-01T00:00:00Z'),
  claimEndsAt: null,
  lotExpiresAt: null,
  lotExpiresInDays: null,
  settlement: 'free',
  ...over,
});

const lot = (id: string, over: Partial<LotFacts> = {}): LotFacts => ({ id, source: 'default', covers: ['instant_apps'], issuedAt: D('2026-11-01T00:00:00Z'), expiresAt: null, availableMicros: 1_000_000, ...over });

describe('recipients', () => {
  it('reads the four kinds, with ISO dates from an API', () => {
    expect(readRecipient({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(readRecipient({ kind: 'new_from', from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' })).toEqual({ kind: 'new_from', from: D('2026-11-01T00:00:00Z'), to: D('2026-12-01T00:00:00Z') });
    expect(readRecipient({ kind: 'people', userIds: ['b', 'a', 'a'] })).toEqual({ kind: 'people', userIds: ['a', 'b'] });
    expect(readRecipient({ kind: 'universe', universeId: 'u1' })).toEqual({ kind: 'universe', universeId: 'u1', mode: 'snapshot' });
    expect(readRecipient({ kind: 'universe', universeId: 'u1', mode: 'changing' })).toEqual({ kind: 'universe', universeId: 'u1', mode: 'changing' });
  });

  it('never accepts a universe role, or anything else, as a recipient', () => {
    for (const bad of [{ kind: 'role', roleId: 'admin' }, { kind: 'team' }, { kind: 'people', userIds: [] }, { kind: 'people', userIds: [3] }, { kind: 'new_from' }, { kind: 'universe' }, null, 'all']) {
      expect(() => readRecipient(bad)).toThrow(CreditRefused);
    }
    expect(() => readRecipient({ kind: 'new_from', from: '2026-11-02', to: '2026-11-01' })).toThrow(CreditRefused);
  });

  it('stores a recipient as columns by id, never by role', () => {
    expect(recipientColumns({ kind: 'universe', universeId: 'u1', mode: 'changing' })).toEqual({ recipientType: 'universe', recipientFrom: null, recipientTo: null, recipientUniverseId: 'u1', recipientMode: 'changing' });
    expect(recipientColumns({ kind: 'all' }).recipientType).toBe('all');
  });

  it('reaches by the account’s real creation time: start included, end not included; signing in again is not signing up', () => {
    const r = rule({ recipient: { kind: 'new_from', from: D('2026-11-01T00:00:00Z'), to: D('2026-12-01T00:00:00Z') } });
    expect(reaches(r, person('a', '2026-11-01T00:00:00Z'))).toBe(true);
    expect(reaches(r, person('a', '2026-11-30T23:59:59Z'))).toBe(true);
    expect(reaches(r, person('a', '2026-12-01T00:00:00Z'))).toBe(false);
    expect(reaches(r, person('a', '2026-10-31T23:59:59Z'))).toBe(false);
  });

  it('a snapshot is the ids saved; a changing universe is whoever has joined it now', () => {
    const snap = rule({ recipient: { kind: 'universe', universeId: 'u1', mode: 'snapshot' }, recipientIds: new Set(['sara']) });
    expect(reaches(snap, person('sara'))).toBe(true);
    expect(reaches(snap, person('omar', undefined, ['u1']))).toBe(false);
    const live = rule({ recipient: { kind: 'universe', universeId: 'u1', mode: 'changing' } });
    expect(reaches(live, person('omar', undefined, ['u1']))).toBe(true);
    expect(reaches(live, person('omar', undefined, ['u2']))).toBe(false);
    const picked = rule({ recipient: { kind: 'people', userIds: ['sara'] }, recipientIds: new Set(['sara']) });
    expect(reaches(picked, person('sara'))).toBe(true);
    expect(reaches(picked, person('omar'))).toBe(false);
  });

  it('opens the claim period at its start and closes it at its end (end not included)', () => {
    const r = rule({ claimStartsAt: D('2026-11-01T00:00:00Z'), claimEndsAt: D('2026-12-01T00:00:00Z') });
    expect(claimOpen(r, D('2026-10-31T23:59:59Z'))).toBe(false);
    expect(claimOpen(r, D('2026-11-01T00:00:00Z'))).toBe(true);
    expect(claimOpen(r, D('2026-12-01T00:00:00Z'))).toBe(false);
  });
});

describe('which rule wins (2a): never "the bigger one"', () => {
  const group = (over: Partial<RuleFacts> = {}) => rule({ programKind: 'exception', recipient: { kind: 'people', userIds: ['sara', 'omar'] }, recipientIds: new Set(['sara', 'omar']), ...over });
  const own = (over: Partial<RuleFacts> = {}) => rule({ programKind: 'exception', recipient: { kind: 'people', userIds: ['sara'] }, recipientIds: new Set(['sara']), ...over });

  it('a person’s own exception, then a group’s, then the default', () => {
    expect(baseRank(own())).toBe(1);
    expect(baseRank(group())).toBe(2);
    expect(baseRank(rule({ programKind: 'exception', recipient: { kind: 'universe', universeId: 'u1', mode: 'snapshot' } }))).toBe(2);
    expect(baseRank(rule())).toBe(3);
    const d = rule({ amount: 1 });
    const g = group({ amount: 2 });
    const o = own({ amount: 3 });
    expect(pickBase([d, g, o])).toEqual({ winner: o });
    expect(pickBase([d, g])).toEqual({ winner: g });
    expect(pickBase([d])).toEqual({ winner: d });
    expect(pickBase([])).toEqual({ winner: null });
  });

  it('a smaller exception beats a bigger default and a bigger group never wins by being bigger', () => {
    const d = rule({ amount: 5_000_000 });
    const g = group({ amount: 1_000_000 });
    expect(pickBase([d, g])).toEqual({ winner: g });
    // "None" is an exception that gives nothing, and it wins over a bigger default
    const none = own({ schedule: 'none', amount: 0 });
    expect(pickBase([d, none])).toEqual({ winner: none });
  });

  it('two group exceptions that disagree give nobody anything by quiet default: it is a clash', () => {
    const a = group({ amount: 1_000_000 });
    const b = group({ amount: 9_000_000 });
    const picked = pickBase([a, b]);
    expect(picked.winner).toBeNull();
    expect((picked as { clash?: unknown }).clash).toEqual([a, b]);
  });

  it('two that say the same thing are one: the same winner whatever order they came in', () => {
    const a = group({ programId: 'pa' });
    const b = group({ programId: 'pb' });
    expect(pickBase([a, b])).toEqual({ winner: a });
    expect(pickBase([b, a])).toEqual({ winner: a });
  });

  it('refuses on save a rule that clashes, naming the people both ways', () => {
    const saved = [group({ programId: 'pa', amount: 1_000_000 })];
    const ids = (r: RuleFacts) => (r.programId === 'pa' ? new Set(['sara', 'omar']) : new Set(['omar', 'noor']));
    const candidate = group({ programId: 'pb', amount: 9_000_000, recipient: { kind: 'people', userIds: ['omar', 'noor'] } });
    expect(findClashes(candidate, saved, ids)).toEqual([{ programId: 'pa', userIds: ['omar'] }]);
  });

  it('does not clash when the people do not overlap, when they say the same, or when one is a single person', () => {
    const saved = [group({ programId: 'pa', amount: 1_000_000 })];
    const idsOf = (r: RuleFacts) => (r.programId === 'pa' ? new Set(['sara', 'omar']) : new Set(['noor']));
    expect(findClashes(group({ programId: 'pb', amount: 9_000_000 }), saved, idsOf)).toEqual([]);
    expect(findClashes(group({ programId: 'pb', amount: 1_000_000 }), saved, () => new Set(['sara', 'omar']))).toEqual([]);
    // A person's own exception is narrower than a group's: it wins, so it is not a clash
    expect(findClashes(own({ programId: 'pc', amount: 9_000_000 }), saved, () => new Set(['sara']))).toEqual([]);
    // Editing a program is not a clash with its own earlier version
    expect(findClashes(group({ programId: 'pa', amount: 9_000_000 }), saved, () => new Set(['sara', 'omar']))).toEqual([]);
  });

  it('two single-person exceptions for the same person that disagree clash', () => {
    const saved = [own({ programId: 'pa', amount: 1_000_000 })];
    expect(findClashes(own({ programId: 'pb', amount: 2_000_000 }), saved, () => new Set(['sara']))).toEqual([{ programId: 'pa', userIds: ['sara'] }]);
  });

  it('gifts never clash: separate gifts add', () => {
    const gift = rule({ programKind: 'gift', recipient: { kind: 'people', userIds: ['sara'] } });
    expect(findClashes(gift, [gift, rule({ programKind: 'gift' })], () => new Set(['sara']))).toEqual([]);
  });
});

describe('what a lot issues, once per period', () => {
  it('a one-off is one lot for good: expiring at a fixed end, days after issuing, or never', () => {
    const now = D('2026-11-15T10:00:00Z');
    expect(planLot(rule(), now)).toMatchObject({ periodKey: 'once', startsAt: now, expiresAt: null, amountMicros: 2_000_000, source: 'default' });
    expect(planLot(rule({ lotExpiresAt: D('2026-12-31T00:00:00Z') }), now)?.expiresAt).toEqual(D('2026-12-31T00:00:00Z'));
    expect(planLot(rule({ lotExpiresInDays: 30 }), now)?.expiresAt).toEqual(D('2026-12-15T10:00:00Z'));
  });

  it('a monthly lot is one a UTC month and ends with the month: nothing rolls over', () => {
    const plan = planLot(rule({ schedule: 'monthly' }), D('2026-11-15T10:00:00Z'));
    expect(plan).toMatchObject({ periodKey: '2026-11', startsAt: D('2026-11-01T00:00:00Z'), expiresAt: D('2026-12-01T00:00:00Z') });
    expect(planLot(rule({ schedule: 'monthly' }), D('2026-11-30T23:59:59Z'))?.periodKey).toBe('2026-11');
    expect(planLot(rule({ schedule: 'monthly' }), D('2026-12-01T00:00:00Z'))?.periodKey).toBe('2026-12');
    expect(monthKey(D('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('issues nothing for "none", and says what kind of record it is', () => {
    expect(planLot(rule({ schedule: 'none', amount: 0 }), new Date())).toBeNull();
    expect(planLot(rule({ programKind: 'gift' }), new Date())?.source).toBe('gift');
    expect(planLot(rule({ programKind: 'gift', settlement: 'to_bill' }), new Date())?.source).toBe('manual_billing');
    expect(planLot(rule({ programKind: 'gift' }), new Date())?.periodKey).toBe('gift');
  });

  it('keys a default and an exception into one slot and a gift into its own; a shared amount is one pool', () => {
    expect(slotKeyFor(rule())).toBe('base:instant_apps');
    expect(slotKeyFor(rule({ programKind: 'exception' }))).toBe('base:instant_apps');
    expect(slotKeyFor(rule({ programKind: 'gift', programId: 'g1' }))).toBe('gift:g1');
    expect(subjectKeyFor(rule({ share: 'each' }), 'sara')).toBe('person:sara');
    expect(subjectKeyFor(rule({ share: 'shared', programId: 'g1' }), 'sara')).toBe('pool:g1');
    expect(subjectKeyFor(rule({ share: 'shared', programId: 'g1' }), 'omar')).toBe('pool:g1');
  });
});

describe('the order credit is spent in (spec 4)', () => {
  it('credit that ends soonest first, then credit that never ends, then purchased credit', () => {
    const lots = [
      lot('purchased', { source: 'purchase' }),
      lot('forever'),
      lot('late', { expiresAt: D('2026-12-31T00:00:00Z') }),
      lot('soon', { expiresAt: D('2026-11-30T00:00:00Z') }),
    ];
    expect(spendOrder(lots).map((l) => l.id)).toEqual(['soon', 'late', 'forever', 'purchased']);
  });

  it('two that end together: the more restricted first, then the oldest, then by id', () => {
    const end = D('2026-12-01T00:00:00Z');
    const lots = [
      lot('c', { expiresAt: end, covers: ['instant_apps', 'computers'] }),
      lot('b', { expiresAt: end, issuedAt: D('2026-11-05T00:00:00Z') }),
      lot('a', { expiresAt: end, issuedAt: D('2026-11-02T00:00:00Z') }),
      lot('a2', { expiresAt: end, issuedAt: D('2026-11-02T00:00:00Z') }),
    ];
    expect(spendOrder(lots).map((l) => l.id)).toEqual(['a', 'a2', 'b', 'c']);
    expect(spendOrder([...lots].reverse()).map((l) => l.id)).toEqual(['a', 'a2', 'b', 'c']);
  });

  it('takes from lots in that order, all or nothing', () => {
    const lots = [lot('forever', { availableMicros: 4_000_000 }), lot('soon', { expiresAt: D('2026-11-30T00:00:00Z'), availableMicros: 1_500_000 })];
    expect(allocate(lots, 2_000_000)).toEqual([
      { lotId: 'soon', amountMicros: 1_500_000 },
      { lotId: 'forever', amountMicros: 500_000 },
    ]);
    expect(allocate(lots, 5_500_000)).toEqual([
      { lotId: 'soon', amountMicros: 1_500_000 },
      { lotId: 'forever', amountMicros: 4_000_000 },
    ]);
    expect(allocate(lots, 5_500_001)).toBeNull();
    expect(allocate([lot('x', { availableMicros: 0 })], 1)).toBeNull();
  });
});

describe('what a charge is: nested work is charged once', () => {
  const categories = [
    { id: 'universe_ai', pays: [] as string[] },
    { id: 'instant_apps', pays: ['instant_run'] },
    { id: 'computers', pays: ['computer_job', 'computer_model', 'computer_tool'] },
  ];

  it('an Instant run is its own class; an App or tool inside a computer job belongs to that job', () => {
    expect(classifyCharge({ work: 'instant', inComputerJob: false })).toBe('instant_run');
    expect(classifyCharge({ work: 'instant', inComputerJob: true })).toBe('computer_tool');
    expect(classifyCharge({ work: 'tool', inComputerJob: true })).toBe('computer_tool');
    expect(classifyCharge({ work: 'computer_time', inComputerJob: true })).toBe('computer_job');
    expect(classifyCharge({ work: 'computer_model', inComputerJob: true })).toBe('computer_model');
  });

  it('the category that pays is the one that lists the class; a class nobody lists, or two list, is paid by nobody', () => {
    expect(categoryFor('instant_run', categories)).toBe('instant_apps');
    expect(categoryFor('computer_tool', categories)).toBe('computers');
    for (const unpaid of ['app_overhead', 'storage', 'model_reply']) expect(categoryFor(unpaid, categories)).toBeNull();
    expect(categoryFor('instant_run', [...categories, { id: 'computers', pays: ['instant_run'] }])).toBeNull();
    expect(categoryFor('instant_run', [{ id: 'instant_apps', pays: ['instant_run'], status: 'retired' }])).toBeNull();
  });
});
