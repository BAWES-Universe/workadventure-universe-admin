/** What held room can still cost, for a rule (the exposure of a lease): it moves only when a renewal moves the end, never with the clock. */
jest.mock('@/lib/db', () => ({ prisma: {} }));
import { exposureOf } from '@/lib/spend-rules';

const min = (n: number) => new Date(Date.UTC(2026, 10, 19, 12, n));
const MIL = 1_000_000;

describe('exposureOf', () => {
  // $1 a minute, a 10 minute stretch: a first stretch is $10, renewed once it holds $20 and ends 10 minutes after the renewal at minute 5
  const renewed = { amountMicros: BigInt(20 * MIL), renewals: 1, createdAt: min(0), expiresAt: min(15) };

  it('counts room taken once whole, and a renewed lease by the time it covers, the same at minute 5 and at minute 9', () => {
    expect(exposureOf([{ amountMicros: BigInt(10 * MIL), renewals: 0, createdAt: min(0), expiresAt: min(10) }], 10, min(5))).toBe(10 * MIL);
    expect(exposureOf([renewed], 10, min(5))).toBe(15 * MIL);
    expect(exposureOf([renewed], 10, min(9))).toBe(15 * MIL);
    expect(exposureOf([renewed], 10, min(14))).toBe(15 * MIL);
  });

  it('is never more than was held, and never less than one stretch', () => {
    expect(exposureOf([{ ...renewed, expiresAt: min(40) }], 10, min(5))).toBe(20 * MIL);
    expect(exposureOf([{ ...renewed, expiresAt: min(3) }], 10, min(5))).toBe(10 * MIL);
  });

  it('a second renewal adds a stretch to what the lease covers', () => {
    expect(exposureOf([{ amountMicros: BigInt(30 * MIL), renewals: 2, createdAt: min(0), expiresAt: min(25) }], 10, min(20))).toBe(25 * MIL);
  });
});
