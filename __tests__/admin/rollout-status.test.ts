/**
 * The rollout budget row says where this month stands (money review of #1049): what was issued against the budget, and how many people
 * were due a default and were not given it because it would go past it, so the budget running out is never silent.
 */
import { exposureStatus, instantLimits, moneyLimits, readInstantExposure, rolloutStatus } from '@/app/admin/components/limits';

describe('the rollout budget row', () => {
  it('says what was issued of the budget this month', () => {
    expect(rolloutStatus(20_000_000, { issuedMicros: 18_250_000, notGivenPeople: 0 })).toBe('Issued $18.25 of $20.00 this month, $1.75 left.');
  });

  it('says how many more people the rest funds at today’s defaults, whole grants only ($20 funds 10 people at $2, $225 funds 112)', () => {
    expect(rolloutStatus(20_000_000, { issuedMicros: 0, notGivenPeople: 0, perPersonMicros: 2_000_000 })).toBe('Issued $0.00 of $20.00 this month, $20.00 left: enough for 10 more people at $2.00 each.');
    expect(rolloutStatus(225_000_000, { issuedMicros: 0, notGivenPeople: 0, perPersonMicros: 2_000_000 })).toBe('Issued $0.00 of $225.00 this month, $225.00 left: enough for 112 more people at $2.00 each.');
    expect(rolloutStatus(20_000_000, { issuedMicros: 17_000_000, notGivenPeople: 0, perPersonMicros: 2_000_000 })).toBe('Issued $17.00 of $20.00 this month, $3.00 left: enough for 1 more person at $2.00 each.');
    expect(rolloutStatus(20_000_000, { issuedMicros: 19_000_000, notGivenPeople: 0, perPersonMicros: 2_000_000 })).toBe('Issued $19.00 of $20.00 this month, $1.00 left: enough for 0 more people at $2.00 each.');
  });

  it('says how many people it left out this month', () => {
    expect(rolloutStatus(20_000_000, { issuedMicros: 20_000_000, notGivenPeople: 1 })).toBe('Issued $20.00 of $20.00 this month, nothing left. 1 person was not given credit this month because it would go past this.');
    expect(rolloutStatus(20_000_000, { issuedMicros: 20_000_000, notGivenPeople: 1204, perPersonMicros: 2_000_000 })).toBe('Issued $20.00 of $20.00 this month, nothing left. 1,204 people were not given credit this month because it would go past this.');
  });

  it('says nothing it cannot read, and no budget when none is set', () => {
    expect(rolloutStatus(20_000_000, null)).toBeUndefined();
    expect(rolloutStatus(null, { issuedMicros: 0, notGivenPeople: 0 })).toBe('Issued $0.00 this month.');
  });

  it('goes by the platform funding account’s own budget when one is set, and says that number is the one in force', () => {
    expect(rolloutStatus(1_000_000_000, { issuedMicros: 0, notGivenPeople: 0, perPersonMicros: 2_000_000, accountBudgetMicros: 20_000_000 })).toBe(
      'Issued $0.00 of $20.00 this month, $20.00 left: enough for 10 more people at $2.00 each. The platform funding account has its own budget of $20.00, and that is the one in force, not this number.',
    );
    expect(rolloutStatus(null, { issuedMicros: 20_000_000, notGivenPeople: 3, accountBudgetMicros: 20_000_000 })).toBe(
      'Issued $20.00 of $20.00 this month, nothing left. 3 people were not given credit this month because it would go past this. The platform funding account has its own budget of $20.00, and that is the one in force, not this number.',
    );
    // No own budget (null, or an older answer without the field): the row's own number
    expect(rolloutStatus(20_000_000, { issuedMicros: 0, notGivenPeople: 0, accountBudgetMicros: null })).toBe('Issued $0.00 of $20.00 this month, $20.00 left.');
  });

  it('is on the row itself', () => {
    expect(moneyLimits({ rolloutBudgetMicros: 20_000_000 }, { issuedMicros: 2_250_000, notGivenPeople: 0 })[0].status).toBe('Issued $2.25 of $20.00 this month, $17.75 left.');
    expect(moneyLimits({ rolloutBudgetMicros: 20_000_000 })[0].status).toBeUndefined();
  });
});

describe('the Instant ceiling row', () => {
  const views = {
    exposureCeilingMicros: { value: 200_000_000, range: { min: 1, max: 1e15 }, recommended: null, label: 'Most Instant may owe', hint: 'h', unit: 'micros' as const, required: true },
    maxRunMicros: { value: 30_000, range: { min: 1, max: 1e9 }, recommended: null, label: 'Most one run may cost', hint: 'h', unit: 'micros' as const, required: true },
  };

  it('says what Instant may owe of its ceiling this month, apart from the rollout budget, and what is left before new runs stop', () => {
    expect(exposureStatus(200_000_000, 12_345_678)).toBe('Used $12.35 of $200.00 this month, $187.65 left.');
    expect(exposureStatus(200_000_000, 200_000_000)).toBe('Used $200.00 of $200.00 this month: new runs stop until next month or a higher number.');
    expect(exposureStatus(null, 1_000_000)).toBe('Used $1.00 this month.');
    expect(exposureStatus(200_000_000, null)).toBeUndefined();
  });

  it('is on the ceiling row only, and only when the answer says it', () => {
    const rows = instantLimits(views, 50_000_000);
    expect(rows.find((row) => row.id === 'exposureCeilingMicros')?.status).toBe('Used $50.00 of $200.00 this month, $150.00 left.');
    expect(rows.find((row) => row.id === 'maxRunMicros')?.status).toBeUndefined();
    expect(instantLimits(views).find((row) => row.id === 'exposureCeilingMicros')?.status).toBeUndefined();
    expect(readInstantExposure({ exposure: { usedMicros: 5 } })).toBe(5);
    expect(readInstantExposure({ exposure: null })).toBeNull();
    expect(readInstantExposure({ exposure: { usedMicros: 'x' } })).toBeNull();
    expect(readInstantExposure(null)).toBeNull();
  });
});
