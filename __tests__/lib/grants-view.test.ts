import { amountLine, audienceTitle, defaultLines, exceptionLines, giftLines, giftPill, microsOfDollars, nameList, previewRows, usd, type AudienceView, type ExceptionView, type GiftView, type PreviewNumbers, type PreviewRequest, type Seg } from '@/lib/grants-view';

/** The grants screens' words (spec v3 sections 2, 7a, 11): real figures from what is typed or previewed, never a built-in amount. */

const flat = (parts: Seg[]) => parts.map((part) => (typeof part === 'string' ? part : part.b)).join('');
const words = (rows: ReturnType<typeof previewRows>) => Object.fromEntries(rows.map(([label, text]) => [label, flat(text)]));

const numbers = (over: Partial<PreviewNumbers> = {}): PreviewNumbers => ({ people: 56, ownRules: 5, laterToo: true, amountMicros: 2_000_000, interval: 'once', shared: false, mostNowMicros: 112_000_000, noLifetimeMax: true, already: [], budget: { budgetMicros: 1_000_000_000, roomMicros: 900_000_000 }, ...over });

describe('typed dollars', () => {
  it('reads only a positive amount in dollars and never guesses', () => {
    expect(microsOfDollars('2')).toBe(2_000_000);
    expect(microsOfDollars(' $2.50 ')).toBe(2_500_000);
    expect(microsOfDollars('1,000')).toBe(1_000_000_000);
    expect(microsOfDollars('1,234.50')).toBe(1_234_500_000);
    // A comma that is not a thousands group is never read as one: "1,50" is not $150
    for (const bad of ['1,50', '1,5', '12,34', '1,2345', ',500', '1,000,00', '1,000,', '1,,000']) expect(microsOfDollars(bad)).toBeNull();
    expect(microsOfDollars('0')).toBeNull();
    expect(microsOfDollars('-5')).toBeNull();
    expect(microsOfDollars('1e2')).toBeNull();
    expect(microsOfDollars('abc')).toBeNull();
    expect(microsOfDollars('')).toBeNull();
    expect(microsOfDollars('0.0000001')).toBeNull();
  });

  it('shows whole dollars without cents and others with two', () => {
    expect(usd(5_000_000)).toBe('$5');
    expect(usd(2_500_000)).toBe('$2.50');
    expect(usd(1_234_000_000)).toBe('$1,234');
  });

  it('lists names in plain words and counts the rest', () => {
    expect(nameList(['Omar', 'Noor'])).toBe('Omar and Noor');
    expect(nameList(['Omar', 'Noor', 'Faisal', 'Lina'], 4)).toBe('Omar, Noor, Faisal and Lina');
    expect(nameList(['A', 'B', 'C', 'D', 'E'], 3)).toBe('A, B and 3 others');
  });
});

describe('the default rows', () => {
  it('says what not set means, for each category', () => {
    const unset = { set: false, amountMicros: null, interval: 'none' as const, recipients: null };
    expect(defaultLines('instant_apps', unset)).toEqual(['Not set', 'Nobody gets Instant Apps credit yet']);
    expect(defaultLines('computers', unset)).toEqual(['Not set', 'Computer jobs are refused until you set it']);
  });

  it('says a one-off and a monthly default with the amount that was typed', () => {
    expect(defaultLines('instant_apps', { set: true, amountMicros: 2_000_000, interval: 'once', recipients: { kind: 'all' } })).toEqual(['$2 once, when someone joins', 'All signed-in members']);
    expect(defaultLines('computers', { set: true, amountMicros: 10_000_000, interval: 'monthly', recipients: { kind: 'all' } })[0]).toBe('$10 a month, renews on the 1st');
  });

  it('says none as no credit from the default, with gifts and exceptions still working', () => {
    expect(defaultLines('computers', { set: true, amountMicros: null, interval: 'none', recipients: { kind: 'all' } })).toEqual(['No credit from the default', 'Exceptions and gifts still work']);
  });
});

describe('exceptions and gifts', () => {
  const people: AudienceView = { kind: 'people', people: ['Omar', 'Noor', 'Faisal', 'Lina'].map((name) => ({ id: name, name, woka: [] })), universe: null, count: 4 };
  const universe: AudienceView = { kind: 'universe', people: [], universe: { id: 'u1', name: 'Kuwait Makers' }, count: 4 };

  it('names a group by its people or its universe', () => {
    expect(audienceTitle(people)).toBe('Omar, Noor, Faisal and Lina');
    expect(audienceTitle(universe)).toBe('Kuwait Makers');
  });

  it('says each category of an exception and leaves out "as everyone"', () => {
    const exception: ExceptionView = { id: 'e1', audience: people, instant_apps: { mode: 'own', amountMicros: 10_000_000, interval: 'monthly' }, computers: { mode: 'none' } };
    expect(exceptionLines(exception)).toEqual(['People you picked', 'Instant Apps $10 a month', 'Computers: no grant']);
    expect(exceptionLines({ ...exception, audience: universe, instant_apps: { mode: 'same' }, computers: { mode: 'own', amountMicros: 5_000_000, interval: 'monthly' } })).toEqual(['Its members', '4 people now', 'Computers $5 a month']);
    expect(amountLine('computers', 5_000_000, 'once')).toBe('Computers $5 once');
  });

  it('says "$5 each, $20 in total" or "shared in total", never both promises', () => {
    const gift: GiftView = { id: 'g1', audience: people, amountMicros: 5_000_000, shared: false, totalMicros: 20_000_000, scope: 'both', endsAt: '2026-12-31T20:59:59.000Z', ended: false, usedMicros: 7_400_000, givenByName: 'Khalid', settlement: 'gift', billedAt: null, payer: 'Paid by Universe' };
    expect(giftLines(gift).slice(0, 2)).toEqual(['$5 each, $20 in total', 'Instant Apps and computers']);
    expect(giftLines({ ...gift, shared: true, amountMicros: 20_000_000 })[0]).toBe('$20 shared in total');
    expect(giftPill(gift)).toBe('A gift');
    expect(giftPill({ settlement: 'to_bill', billedAt: null })).toBe('To bill');
    expect(giftPill({ settlement: 'to_bill', billedAt: '2026-12-01T00:00:00Z' })).toBe('Billed');
  });
});

describe('the three-part preview', () => {
  const once: PreviewRequest = { what: 'default', category: 'instant_apps', amountMicros: 2_000_000, interval: 'once', recipients: { kind: 'all' } };

  it('shows three separate parts for a default: who gets what, most credit issued, what it can cost us', () => {
    const rows = previewRows(once, numbers());
    expect(rows.map(([label]) => label)).toEqual(['Who gets what', 'Most credit issued', 'What it can cost us']);
    const said = words(rows);
    expect(said['Who gets what']).toContain('56 people get $2 once, now (5 people have their own rules)');
    expect(said['Most credit issued']).toContain('$112 now, plus $2 for each new account. No end date, so there is no lifetime maximum');
    // A dollar of credit is not a dollar of provider cost
    expect(said['What it can cost us']).toContain('A dollar of credit is not a dollar of provider cost');
  });

  it('says plainly when a group has no lifetime maximum, and does not when it does', () => {
    expect(words(previewRows(once, numbers({ noLifetimeMax: false, laterToo: false })))['Most credit issued']).not.toContain('no lifetime maximum');
  });

  it('says a monthly default per month and that what is left does not carry over', () => {
    const monthly: PreviewRequest = { ...once, interval: 'monthly', startsOn: 'next', amountMicros: 10_000_000 };
    const said = words(previewRows(monthly, numbers({ interval: 'monthly', amountMicros: 10_000_000, mostNowMicros: 560_000_000, startsOn: 'next' })));
    expect(said['Who gets what']).toContain('get $10 a month from the 1st');
    expect(said['Who gets what']).toContain('doesn’t carry over');
    expect(said['Most credit issued']).toContain('Up to $560 a month');
  });

  it('says an exception’s one-time credit and its monthly credit apart, never as one monthly sum', () => {
    const request: PreviewRequest = { what: 'exception', audience: { kind: 'people', userIds: ['a'] }, instant_apps: { mode: 'own', amountMicros: 10_000_000, interval: 'once' }, computers: { mode: 'same' } };
    expect(words(previewRows(request, numbers({ people: 1, mostNowMicros: 10_000_000, mostOnceMicros: 10_000_000, mostMonthlyMicros: null })))['Most credit issued']).toContain('Up to $10 once');
    expect(words(previewRows(request, numbers({ people: 1, mostNowMicros: 10_000_000, mostOnceMicros: 10_000_000, mostMonthlyMicros: null })))['Most credit issued']).not.toContain('a month');
    expect(words(previewRows(request, numbers({ people: 1, mostNowMicros: 15_000_000, mostOnceMicros: 10_000_000, mostMonthlyMicros: 5_000_000 })))['Most credit issued']).toContain('Up to $5 a month and $10 once');
  });

  it('says none as nobody getting the default, without a made-up figure', () => {
    const rows = previewRows({ ...once, interval: 'none', amountMicros: null }, null);
    expect(rows).toHaveLength(1);
    expect(flat(rows[0][1])).toContain('Nobody gets Instant Apps credit from the default');
  });

  it('asks for an amount before it shows anything else', () => {
    expect(flat(previewRows(once, null)[0][1])).toBe('Type an amount to see who gets it and what it can cost.');
  });

  it('says a gift for each person is one amount for either use, and a shared one is one pool', () => {
    const each: PreviewRequest = { what: 'gift', audience: { kind: 'people', userIds: ['a', 'b', 'c', 'd'] }, scope: 'both', amountMicros: 5_000_000, shared: false, endsAt: '2026-12-31T00:00:00Z' };
    const eachWords = words(previewRows(each, numbers({ people: 4, ownRules: 0, laterToo: false, amountMicros: 5_000_000, mostNowMicros: 20_000_000, noLifetimeMax: false, endsOn: '31 Dec', already: ['Omar already has $10 a month from an exception. This is a separate gift, so it adds.'] })));
    expect(eachWords['Who gets what']).toContain('Each of the 4 gets one $5 for Instant Apps or computers, not $5 for each');
    expect(eachWords['Most credit issued']).toContain('$20 in total, ending 31 Dec');
    expect(eachWords['Already has']).toContain('separate gift, so it adds');
    const shared = words(previewRows({ ...each, amountMicros: 20_000_000, shared: true }, numbers({ people: 4, laterToo: false, amountMicros: 20_000_000, shared: true, mostNowMicros: 20_000_000, noLifetimeMax: false })));
    expect(shared['Who gets what']).toContain('The 4 share one $20');
    expect(shared['Who gets what']).toContain('Two people can never spend the same dollar at once');
  });

  it('warns about the budget by what is issued now, not by the most a changing gift can reach', () => {
    const changing: PreviewRequest = { what: 'gift', audience: { kind: 'universe', universeId: 'u', mode: 'changing' }, scope: 'both', amountMicros: 5_000_000, shared: false, endsAt: '2026-12-31T00:00:00Z', joinerCap: 3 };
    // One member now, three may join: up to $20, but only $5 is issued at saving and $10 of room is left
    const rows = previewRows(changing, numbers({ people: 1, ownRules: 0, laterToo: true, amountMicros: 5_000_000, mostNowMicros: 20_000_000, issuedNowMicros: 5_000_000, noLifetimeMax: false, endsOn: '31 Dec', budget: { budgetMicros: 100_000_000, roomMicros: 10_000_000 } }));
    const said = words(rows);
    expect(said['Most credit issued']).toContain('$20 in total');
    expect(said['Funding']).toBeUndefined();
    // When what is issued now is more than the room, it still says so
    const tight = words(previewRows(changing, numbers({ people: 3, ownRules: 0, laterToo: true, amountMicros: 5_000_000, mostNowMicros: 30_000_000, issuedNowMicros: 15_000_000, noLifetimeMax: false, endsOn: '31 Dec', budget: { budgetMicros: 100_000_000, roomMicros: 10_000_000 } })));
    expect(tight['Funding']).toContain('Raise the budget in Limits first');
  });
});
