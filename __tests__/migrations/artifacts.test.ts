/**
 * Live artifacts (game #1422, Orbit #622) migration: runs the real migrations on a throwaway database, then this one.
 * Two new tables; nothing already saved changes.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let result: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-artifacts-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string);
}, 150_000);

describe('artifacts migration', () => {
  it('changes nothing already saved', () => {
    expect(result.after).toEqual(result.before);
  });

  it('starts an artifact open to its chat, changeable by its owner, on version 1, in no chat, never expiring', () => {
    expect(result.defaults).toEqual([
      { open_scope: 'chat', change_scope: 'owner', latest_version: 1, chat_kind: null, chat_ref: null, copied_from_id: null, expires_at: null },
    ]);
  });

  it('keeps one row per version number of an artifact, and no version without an artifact', () => {
    expect(result.duplicateVersion).toMatch(/duplicate key|unique/i);
    expect(result.orphanVersion).toMatch(/foreign key/i);
  });

  it('holds an artifact with no owner, for a guest', () => {
    expect(result.guestArtifact).toBe('ok');
  });

  it('keeps a version, and the name it was asked under, when the person who asked leaves', () => {
    expect(result.afterAskerLeft).toEqual([
      { number: 1, asked_by_id: 'owner', asked_by_name: 'Owner' },
      { number: 2, asked_by_id: null, asked_by_name: 'Asker' },
    ]);
  });

  it('removes an owner\'s artifacts with their versions when the owner leaves, and keeps a guest\'s', () => {
    expect(result.afterOwnerLeft).toEqual({ artifacts: [{ id: 'g1' }], versions: [] });
  });
});
