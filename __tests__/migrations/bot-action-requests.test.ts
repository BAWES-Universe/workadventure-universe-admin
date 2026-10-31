/**
 * Saved bot actions (#739) migration: runs the real migrations on a throwaway database, then the saved actions one, and
 * checks what the tables refuse. The rules on top of them are tested in __tests__/lib/bot-actions.test.ts.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  tablesBefore: number;
  tablesAfter: string[];
  checks: Record<string, boolean>;
  leftAfterBotDeleted: Record<string, number>;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-action-requests-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('saved bot actions migration', () => {
  it('adds the four tables and changes nothing that exists', () => {
    expect(result.tablesBefore).toBe(0);
    expect(result.tablesAfter).toEqual(['bot_action_attempts', 'bot_action_decisions', 'bot_action_grants', 'bot_action_requests']);
  });

  it('accepts a waiting request, an approved one with its start time, a closed one with its reason, and couldn’t confirm', () => {
    expect(result.checks).toMatchObject({ waiting: true, approvedWithStartBy: true, closedWithReason: true, couldntConfirm: true });
  });

  it('refuses an unknown status, heading or closing reason', () => {
    expect(result.checks).toMatchObject({ unknownStatus: false, unknownHeading: false, unknownReason: false });
  });

  it('refuses a closed request with no reason, a reason on one that is not closed, and a done one with no finish time', () => {
    expect(result.checks).toMatchObject({ closedWithoutReason: false, reasonWithoutClosed: false, doneWithoutFinishTime: false });
  });

  it('refuses an approved request with no start deadline, and a revision below 1', () => {
    expect(result.checks).toMatchObject({ approvedWithoutStartBy: false, revisionZero: false });
  });

  it('keeps one request per bot and key', () => {
    expect(result.checks.sameKeyTwice).toBe(false);
  });

  it('lets only one attempt of a request be claimed at a time, but another once the first has ended', () => {
    expect(result.checks).toMatchObject({ firstClaimed: true, secondClaimed: false, secondAfterFinished: true });
  });

  it('keeps attempt numbers apart and refuses an unknown attempt state', () => {
    expect(result.checks).toMatchObject({ sameAttemptNumber: false, unknownAttemptState: false });
  });

  it('remembers an approval for changing or making, never for deleting or sending', () => {
    expect(result.checks).toMatchObject({ rememberChange: true, rememberMake: true, rememberDelete: false });
  });

  it('goes away with its bot', () => {
    expect(result.leftAfterBotDeleted).toEqual({ bot_action_requests: 0, bot_action_decisions: 0, bot_action_attempts: 0, bot_action_grants: 0 });
  });
});
