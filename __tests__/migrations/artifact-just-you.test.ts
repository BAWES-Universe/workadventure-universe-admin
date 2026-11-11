/**
 * "Just you" (game #1994) migration: runs the real migrations on a throwaway database. Every artifact that exists today
 * comes through untouched, with who can open it as it was; nothing becomes private by itself. The two new tables hold
 * what they are for: one opening of a private artifact by its owner, and the files still to be removed from the bucket.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { artifacts: Row[]; versions: Row[] };
  after: { artifacts: Row[]; versions: Row[] };
  checks: Record<string, boolean>;
  passesBefore: string[];
  freshPass: Row;
  afterArtifactGone: { passes: string[]; retired: number };
  afterOwnerGone: string[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-artifact-just-you-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('"Just you": the migration', () => {
  it('leaves every artifact that exists today as it was, with its versions, files and media', () => {
    expect(result.before.artifacts).toHaveLength(2);
    expect(result.before.versions).toHaveLength(3);
    expect(result.after).toEqual(result.before);
  });

  it('makes nothing private by itself: who can open each one is what its owner chose', () => {
    expect(result.after.artifacts.map((artifact) => artifact.open_scope)).toEqual(['chat', 'link']);
  });

  it('lets an owner keep one to themselves from now on', () => {
    expect(result.checks.justYou).toBe(true);
  });

  it('keeps one opening per address, for an artifact and a person that exist', () => {
    expect(result.checks.pass).toBe(true);
    expect(result.checks.secondPass).toBe(true);
    expect(result.checks.sameAddressTwice).toBe(false);
    expect(result.checks.passForNoArtifact).toBe(false);
    expect(result.checks.passForNobody).toBe(false);
  });

  it('starts a pass unopened: no browser is tied to it until the page is first asked for', () => {
    expect(result.freshPass).toEqual({ cookie_hash: null, redeemed_at: null, stamped: true });
  });

  it('lists a file to remove once', () => {
    expect(result.checks.retired).toBe(true);
    expect(result.checks.retiredTwice).toBe(false);
  });

  it('ends a pass with its artifact, and with its person’s account, and keeps the files still to remove', () => {
    expect(result.passesBefore).toEqual(['p1', 'p5']);
    expect(result.afterArtifactGone).toEqual({ passes: ['p5'], retired: 1 });
    expect(result.afterOwnerGone).toEqual([]);
  });
});
