/**
 * The companion repair (#365): the user-outfits migration gave back an older pet to people whose last choice was "no
 * companion". The helper runs the real migrations on a throwaway database: the old per-world rows, the user-outfits
 * migration, a pick made after it, then the repair.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Companions = { id: string; companion_texture_id: string | null }[];
type Result = { afterOutfits: Companions; afterRepair: Companions; userAvatars: number };

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-companion-none-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const companionOf = (rows: Companions, id: string) => rows.find((row) => row.id === id)?.companion_texture_id;

describe('companion repair after the user-outfits migration', () => {
  it('the user-outfits migration gave a pet back to someone whose last choice was "no companion"', () => {
    expect(companionOf(result.afterOutfits, 'dee')).toBe('dog1');
  });

  it('clears it again when "no companion" (in a world with no Woka saved) is newer than every pet', () => {
    expect(companionOf(result.afterRepair, 'dee')).toBeNull();
  });

  it('leaves a pet when the row without one also has a Woka: it may only mean they never chose one there', () => {
    expect(companionOf(result.afterRepair, 'eve')).toBe('dog1');
  });

  it('leaves a pet picked after "no companion", and a companion picked after the outfits migration', () => {
    expect(companionOf(result.afterRepair, 'fay')).toBe('dog1');
    expect(companionOf(result.afterRepair, 'gus')).toBe('cat1');
  });

  it('leaves people with no companion as they are, and a tie between "none" and a pet alone', () => {
    expect(companionOf(result.afterRepair, 'hal')).toBeNull();
    expect(companionOf(result.afterRepair, 'ivy')).toBe('dog1');
  });

  it('changes nothing else: every saved row is still there', () => {
    expect(result.userAvatars).toBe(12);
  });
});
