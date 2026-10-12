/**
 * The user-outfits migration turns what people saved per world into the new history: one outfit per distinct Woka (the
 * newest is the one they wear now) and the companion they wear now on the person. The helper runs it on a copy of the
 * database made by every earlier migration.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  outfits: { user_id: string; texture_ids: string[]; outfit_key: string; first_worn_at: string; last_worn_at: string }[];
  companions: { id: string; companion_texture_id: string | null }[];
  userAvatars: number;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-user-outfits-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

const outfitsOf = (userId: string) => result.outfits.filter((row) => row.user_id === userId);

describe('user outfits migration, on what people saved before', () => {
  it('makes one row per distinct outfit, however many worlds it was saved in', () => {
    expect(outfitsOf('ann').map((row) => row.outfit_key)).toEqual(['male2', 'male1|hat1']);
    expect(outfitsOf('ann').map((row) => row.texture_ids)).toEqual([['male2'], ['male1', 'hat1']]);
  });

  it('makes the newest outfit the one they wear now, and dates each from when it was picked', () => {
    const [newest, older] = outfitsOf('ann');
    expect(newest).toMatchObject({ outfit_key: 'male2', first_worn_at: '2026-10-05 10:00:00', last_worn_at: '2026-10-05 10:00:00' });
    // The same outfit saved in two worlds: first worn at the earlier pick, last worn at the later one
    expect(older).toMatchObject({ first_worn_at: '2026-10-01 10:00:00', last_worn_at: '2026-10-03 10:00:00' });
  });

  it('falls back to the update time for rows without an outfit time, and skips empty outfits', () => {
    expect(outfitsOf('bob')).toEqual([
      { user_id: 'bob', texture_ids: ['male3'], outfit_key: 'male3', first_worn_at: '2026-09-20 08:00:00', last_worn_at: '2026-09-20 08:00:00' },
    ]);
    expect(outfitsOf('cy')).toEqual([]);
  });

  it('copies the companion from the most recently updated row that has one, and leaves people without one empty', () => {
    expect(result.companions).toEqual([
      { id: 'ann', companion_texture_id: 'cat1' },
      { id: 'bob', companion_texture_id: null },
      { id: 'cy', companion_texture_id: 'dog2' },
    ]);
  });

  it('drops nothing: the saved rows are all still there', () => {
    expect(result.userAvatars).toBe(6);
  });
});
