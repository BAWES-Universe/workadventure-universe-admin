/**
 * The rollout budget row says where this month stands (money review of #1049): what was issued against the budget, and how many people
 * were due a default and were not given it because it would go past it, so the budget running out is never silent.
 */
import { moneyLimits, rolloutStatus } from '@/app/admin/components/limits';

describe('the rollout budget row', () => {
  it('says what was issued of the budget this month', () => {
    expect(rolloutStatus(20_000_000, { issuedMicros: 18_250_000, notGivenPeople: 0 })).toBe('Issued $18.25 of $20.00 this month.');
  });

  it('says how many people it left out this month', () => {
    expect(rolloutStatus(20_000_000, { issuedMicros: 20_000_000, notGivenPeople: 1 })).toBe('Issued $20.00 of $20.00 this month. 1 person was not given credit this month because it would go past this.');
    expect(rolloutStatus(20_000_000, { issuedMicros: 20_000_000, notGivenPeople: 1204 })).toBe('Issued $20.00 of $20.00 this month. 1,204 people were not given credit this month because it would go past this.');
  });

  it('says nothing it cannot read, and no budget when none is set', () => {
    expect(rolloutStatus(20_000_000, null)).toBeUndefined();
    expect(rolloutStatus(null, { issuedMicros: 0, notGivenPeople: 0 })).toBe('Issued $0.00 this month.');
  });

  it('is on the row itself', () => {
    expect(moneyLimits({ rolloutBudgetMicros: 20_000_000 }, { issuedMicros: 2_250_000, notGivenPeople: 0 })[0].status).toBe('Issued $2.25 of $20.00 this month.');
    expect(moneyLimits({ rolloutBudgetMicros: 20_000_000 })[0].status).toBeUndefined();
  });
});
