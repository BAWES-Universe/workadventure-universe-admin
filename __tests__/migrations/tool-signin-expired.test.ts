/**
 * "Tool sign-in expired" (game #1819) migration: runs the real migrations on a throwaway database. Every tool server and
 * notice starts as it was, with nothing down and no one recorded as having connected it.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = { server: Row; notice: Row; connected: Row; badPerson: boolean; afterDelete: Row };

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-tool-signin-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('tool sign-in expired migration', () => {
  it('leaves a tool server with nothing down and no one recorded', () => {
    expect(result.server).toEqual({ sign_in_lost_at: null, sign_in_lost_status: null, no_answer_at: null, reconnected_at: null, connected_by_id: null });
  });

  it('leaves existing notices as they were, with no data', () => {
    expect(result.notice).toEqual({ title: 'A key is down', data: null });
  });

  it('keeps who connected it and the status, only for a real person', () => {
    expect(result.connected).toEqual({ connected_by_id: 'yousef', sign_in_lost_status: 401 });
    expect(result.badPerson).toBe(false);
  });

  it('forgets the person, not the connection, when they are deleted', () => {
    expect(result.afterDelete).toEqual({ connected_by_id: null, sign_in_lost_status: 401 });
  });
});
