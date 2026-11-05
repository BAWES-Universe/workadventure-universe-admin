/**
 * Ownership offers (#820) migration: runs the real migrations on a throwaway database. Nothing about existing universes
 * changes, a universe has at most one offer, and an offer goes with its universe.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: { id: string; name: string; owner_id: string }[];
  after: { id: string; name: string; owner_id: string; owner_since: string | null; previous_owner_id: string | null }[];
  checks: Record<string, boolean>;
  offersBefore: string[];
  passed: { owner_id: string; previous_owner_id: string | null };
  offersAfterUniverseGone: string[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-ownership-offers-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('ownership offers migration', () => {
  it('changes nothing about universes that exist: same owner, nobody passed it on', () => {
    expect(result.after.map(({ id, name, owner_id }) => ({ id, name, owner_id }))).toEqual(result.before);
    for (const universe of result.after) expect(universe).toMatchObject({ owner_since: null, previous_owner_id: null });
  });

  it('allows one waiting offer per universe, and one in each other universe', () => {
    expect(result.checks).toMatchObject({ firstOffer: true, secondOfferSameUniverse: false, offerInOtherUniverse: true });
    expect(result.offersBefore).toEqual(['o1', 'o3']);
  });

  it('only names universes and people that exist', () => {
    expect(result.checks).toMatchObject({ unknownUniverse: false, unknownPerson: false });
  });

  it('saves when a universe was passed on and from whom', () => {
    expect(result.checks.passedOn).toBe(true);
  });

  it('goes with the universe, and an account that gave a universe away does not take it with them', () => {
    expect(result.offersAfterUniverseGone).toEqual(['o1']);
    expect(result.passed).toEqual({ owner_id: 'lab', previous_owner_id: null });
  });
});
