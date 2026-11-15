/**
 * The funding books (paying spec v3, O1): the migration, run on a throwaway database built from every migration before it. Nothing that
 * exists today is touched, nothing is issued, and from then on the database itself keeps one default per category, one current version
 * per program, one lot per slot, subject and period, and credit never below zero or over what was held.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: unknown;
  after: unknown;
  counts: Record<string, number>;
  categories: { id: string; benefit: string; unit: string; pays: string[] }[];
  accounts: { id: string; kind: string; name: string; status: string }[];
  checks: Record<string, boolean>;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-funding-books-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('the funding books: the migration', () => {
  it('leaves accounts, universes, saved settings and meter gifts exactly as they were', () => {
    expect(result.after).toEqual(result.before);
  });

  it('starts empty: nobody is issued anything until a program is saved', () => {
    expect(result.counts).toEqual({ lots: 0, holds: 0, programs: 0, rules: 0 });
  });

  it('seeds the three categories, replies in replies and money in micros, and the platform’s own account', () => {
    expect(result.categories.map((c) => [c.id, c.unit])).toEqual([['computers', 'usd_micros'], ['instant_apps', 'usd_micros'], ['universe_ai', 'reply']]);
    expect(result.categories.find((c) => c.id === 'universe_ai')?.pays).toEqual([]);
    expect(result.categories.find((c) => c.id === 'instant_apps')?.pays).toEqual(['instant_run']);
    expect(result.accounts).toEqual([{ id: 'funding-platform', kind: 'platform', owner_key: 'platform', name: 'BAWES Universe', status: 'active' }]);
  });
});

describe('the funding books: what the database keeps', () => {
  it('keeps one active default per category, and a request key to one program', () => {
    expect(result.checks).toMatchObject({ programOk: true, defaultOk: true, secondActiveDefault: false, endedDefaultThenOk: true, requestKeyOnce: false, programOtherKind: false });
  });

  it('keeps one current version per program, never two of one number, and no role as a recipient', () => {
    expect(result.checks).toMatchObject({ ruleOk: true, secondCurrentRule: false, supersededThenOk: true, sameVersionTwice: false, roleRecipient: false });
  });

  it('refuses a grant that gives nothing or nothing that is a grant, unagreed billing, uncapped changing groups and a claim that ends before it starts', () => {
    expect(result.checks).toMatchObject({ noGrantWithAmount: false, grantWithoutAmount: false, billedNeedsAgreement: false, changingNeedsCaps: false, claimEndsBeforeStart: false });
  });

  it('keeps a lot to one per slot, subject and period, never empty or negative, always for a person or a pool, always ending after it starts', () => {
    expect(result.checks).toMatchObject({ lotOk: true, sameLotTwice: false, zeroLot: false, negativeLot: false, lotWithoutPerson: false, poolWithPerson: false, lotOtherSource: false, lotNoCovers: false, lotEndsBeforeStart: false, billedFreeLot: false });
  });

  it('keeps a hold to one per key and one live hold per execution (a released one took nothing), for money only, never charged over what was held or refunded over what was charged', () => {
    expect(result.checks).toMatchObject({ holdOk: true, holdKeyTwice: false, holdForReplies: false, holdOfNothing: false, chargedMoreThanHeld: false, settledWithoutCharge: false, refundedMoreThanCharged: false, effectKeyOnce: false, effectKeyAfterRelease: true, effectKeyReleasedTwice: true });
  });

  it('knows only its own funding account kinds, one platform account, and no negative budget', () => {
    expect(result.checks).toMatchObject({ accountOwnerForPlatform: false, personAccountOk: true, accountOtherKind: false, negativeBudget: false, secondPlatform: false });
  });
});
