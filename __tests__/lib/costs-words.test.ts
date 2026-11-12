/** The plain words of the Costs page (game #1999): what a figure is called, never more than the books say. */
import { amountWords, computerTime, didLine, dollars, givenDates, givenPill, goesLines } from '@/lib/costs-words';
import { sureOf } from '@/lib/meter-costs';

describe('money', () => {
  it('shows cents, and a cost under half a cent as under a cent rather than $0.00', () => {
    expect(dollars(11_900_000)).toBe('$11.90');
    expect(dollars(310_000)).toBe('$0.31');
    expect(dollars(0)).toBe('$0.00');
    expect(dollars(3)).toBe('<$0.01');
  });
});

describe('what a person or a Brick did', () => {
  it('lists only what it did, with plurals', () => {
    expect(didLine({ replies: 264, appUses: 96, computerSeconds: 26 * 3600 })).toEqual(['264 replies', '96 app uses', '26 hours of computer']);
    expect(didLine({ replies: 1, appUses: 1, computerSeconds: 0 })).toEqual(['1 reply', '1 app use']);
    expect(didLine({ replies: 0, appUses: 0, computerSeconds: 0 })).toEqual([]);
  });

  it('says computer time in hours, or in minutes under an hour, and nothing when it did not run', () => {
    expect(computerTime(0)).toBeNull();
    expect(computerTime(1)).toBe('1 minute of computer');
    expect(computerTime(40 * 60)).toBe('40 minutes of computer');
    expect(computerTime(3600)).toBe('1 hour of computer');
  });
});

describe('extra usage given', () => {
  it('names the amount and says when it ran, and that it ended', () => {
    expect(amountWords({ multiplier: 2, noLimit: false })).toBe('Twice the usual');
    expect(amountWords({ multiplier: 5, noLimit: false })).toBe('5 times the usual');
    expect(amountWords({ multiplier: null, noLimit: true })).toBe('No limit');
    expect(givenDates({ startsAt: '2026-11-10T09:00:00Z', endsAt: '2026-11-30T20:00:00Z', ended: false })).toBe('10 Nov to 30 Nov');
    expect(givenDates({ startsAt: '2026-11-01T09:00:00Z', endsAt: '2026-11-07T12:00:00Z', ended: true })).toBe('1 Nov to 7 Nov, ended');
  });

  it('marks extra usage to bill as "To bill" until it is billed, and a gift as a gift, never billed', () => {
    expect(givenPill({ settlement: 'to_bill', billedAt: null })).toBe('To bill');
    expect(givenPill({ settlement: 'to_bill', billedAt: '2026-11-12T00:00:00Z' })).toBe('Billed');
    expect(givenPill({ settlement: 'gift', billedAt: null })).toBe('A gift');
  });
});

describe('how sure a figure is', () => {
  const counts = (over: object) => ({ measured: 0, estimated: 0, unpriced: 0, others: 0, ...over });
  it('is measured only when everything priced is measured', () => {
    expect(sureOf(counts({ measured: 5 }))).toBe('Measured');
  });
  it('is estimated when any of it is a list price, or has no price yet beside priced ones', () => {
    expect(sureOf(counts({ measured: 5, estimated: 1 }))).toBe('Estimated');
    expect(sureOf(counts({ measured: 5, unpriced: 1 }))).toBe('Estimated');
  });
  it('is unknown when nothing has a price, and never measured', () => {
    expect(sureOf(counts({ unpriced: 3 }))).toBe('Unknown');
    expect(sureOf(counts({}))).toBe('Unknown');
  });
  it('is paid by someone else when that is all there is: their key, their bill', () => {
    expect(sureOf(counts({ others: 4 }))).toBe('Paid by someone else');
  });
});

describe('our count and theirs', () => {
  const row = (over: object) => ({ key: 'models' as const, title: 'AI models', ourMicros: 28_400_000, settledMicros: 26_000_000, uses: null, bytes: null, unpriced: 0, sure: 'Measured' as const, ...over });
  it('puts what the provider settled beside our count', () => {
    expect(goesLines(row({}))).toEqual(['Our count $28.40', 'settled by the provider $26.00']);
  });
  it('says plainly when something has no price yet, never as nothing', () => {
    expect(goesLines(row({ unpriced: 2 }))).toEqual(['Our count $28.40', 'settled by the provider $26.00', '2 uses have no price yet']);
    expect(goesLines(row({ ourMicros: null, settledMicros: null, unpriced: 1 }))).toEqual(['Our count not known yet', '1 use has no price yet']);
  });
  it('counts app uses and says the files we keep with no price until one is set', () => {
    expect(goesLines(row({ key: 'apps', uses: 1240, ourMicros: 0 }))).toEqual(['1,240 uses', 'Our count $0.00']);
    expect(goesLines(row({ key: 'files', bytes: 3_100_000_000, ourMicros: null }))).toEqual(['3.1 GB kept', 'no price set yet']);
    expect(goesLines(row({ key: 'files', bytes: 0, ourMicros: null }))[0]).toBe('Nothing kept yet');
  });
});
