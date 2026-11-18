/**
 * The Instant credit door: shut until the funding books are wired in, opened once by the server at start, and still open in a route bundle
 * that loaded its own copy of the modules. The books themselves are tested on a real database (credit-books-db, spend-rules-db).
 */
jest.mock('@/lib/credit-spend', () => ({
  holdCredit: jest.fn(),
  refundHold: jest.fn(),
  releaseHold: jest.fn(),
  releaseKeyIfNothingHeld: jest.fn(),
  settleHold: jest.fn(),
}));
jest.mock('@/lib/spend-rules', () => ({ checkSpend: jest.fn() }));

describe('wiring the Instant credit books', () => {
  afterEach(async () => {
    const { setInstantFunds } = await import('@/lib/instant/funds');
    setInstantFunds(undefined);
  });

  it('is shut until the books are wired in, and shut again when unwired', async () => {
    const funds = await import('@/lib/instant/funds');
    const { wireInstantFunds } = await import('@/lib/funding/instant-funds');
    expect(funds.instantFundsAreWired()).toBe(false);
    wireInstantFunds();
    expect(funds.instantFundsAreWired()).toBe(true);
    funds.setInstantFunds(undefined);
    expect(funds.instantFundsAreWired()).toBe(false);
  });

  it('stays wired in a copy of the modules loaded after the server wired it (another route bundle)', async () => {
    const first = await import('@/lib/instant/funds');
    const { wireInstantFunds } = await import('@/lib/funding/instant-funds');
    wireInstantFunds();
    jest.resetModules();
    const second = await import('@/lib/instant/funds');
    expect(second).not.toBe(first);
    expect(second.instantFundsAreWired()).toBe(true);
    expect(second.getInstantFunds()).toBe(first.getInstantFunds());
  });

  it('answers a refused reservation of a closed key as unavailable, never as used-up credit', async () => {
    const { holdCredit } = await import('@/lib/credit-spend');
    (holdCredit as jest.Mock).mockResolvedValue({ ok: false, reason: 'closed' });
    const { createInstantFunds } = await import('@/lib/funding/instant-funds');
    const answer = await createInstantFunds().reserve({ key: 'k', personId: 'p', amountMicros: 1, charge: { class: 'instant', route: 'composio', provider: 'composio' } });
    expect(answer).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('release: a hold that exists is released; none held closes the key; a hold that landed meanwhile is released on the second look', async () => {
    const spend = await import('@/lib/credit-spend');
    const { createInstantFunds } = await import('@/lib/funding/instant-funds');
    const funds = createInstantFunds();
    (spend.releaseHold as jest.Mock).mockResolvedValueOnce({ state: 'released' });
    expect(await funds.release({ key: 'a' })).toEqual({ ok: true });

    (spend.releaseHold as jest.Mock).mockResolvedValueOnce(null);
    (spend.releaseKeyIfNothingHeld as jest.Mock).mockResolvedValueOnce('closed');
    expect(await funds.release({ key: 'b' })).toEqual({ ok: false, none: true });

    (spend.releaseHold as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce({ state: 'released' });
    (spend.releaseKeyIfNothingHeld as jest.Mock).mockResolvedValueOnce('held');
    expect(await funds.release({ key: 'c' })).toEqual({ ok: true });

    // A settled hold is not given back, and is not "none" either: the run stays held for the sweep
    (spend.releaseHold as jest.Mock).mockResolvedValueOnce({ state: 'settled' });
    expect(await funds.release({ key: 'd' })).toEqual({ ok: false });

    // The books failing is a plain no, never "none" (a run is never closed over a hold that may exist)
    (spend.releaseHold as jest.Mock).mockRejectedValueOnce(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await funds.release({ key: 'e' })).toEqual({ ok: false });
  });

  it('settle: answers the amount the books recorded, not the one asked, and nothing when it was not charged', async () => {
    const spend = await import('@/lib/credit-spend');
    const { createInstantFunds } = await import('@/lib/funding/instant-funds');
    const funds = createInstantFunds();
    (spend.settleHold as jest.Mock).mockResolvedValueOnce({ state: 'settled', customerMicros: 400_000 });
    expect(await funds.settle({ key: 'a', chargeMicros: 250_000 })).toEqual({ ok: true, chargedMicros: 400_000 });
    (spend.settleHold as jest.Mock).mockResolvedValueOnce({ state: 'released', customerMicros: null });
    expect(await funds.settle({ key: 'b', chargeMicros: 1 })).toEqual({ ok: false });
    (spend.settleHold as jest.Mock).mockResolvedValueOnce(null);
    expect(await funds.settle({ key: 'c', chargeMicros: 1 })).toEqual({ ok: false });
  });
});
