/**
 * A Brick's computer (game #2000, Brick 9): the migration, run on a throwaway database built from every migration before it.
 * Nothing that exists today is touched or copied in, no Brick has a computer until its owner gives it one, and from then on the
 * database itself keeps one computer per Brick, one WRITING job at a time on it, the words each column may hold, and an effect
 * outside the computer to one row per key.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[] };
  after: { users: Row[]; bots: Row[] };
  countsAfterMigration: { computers: number; jobs: number; effects: number };
  checks: Record<string, unknown>;
  afterBrickGone: { computers: number; jobs: number; effects: number };
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-computer-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('Brick computers: the migration', () => {
  it('leaves every account and bot that exists today as it was', () => {
    expect(result.before.users).toHaveLength(2);
    expect(result.before.bots).toHaveLength(11);
    expect(result.after).toEqual(result.before);
  });

  it('starts empty: no Brick has a computer, no job exists, nothing is switched on for anybody', () => {
    expect(result.countsAfterMigration).toEqual({ computers: 0, jobs: 0, effects: 0 });
  });
});

describe('Brick computers: what the database keeps', () => {
  it('gives a Brick one computer, never one for a room bot or nobody, and it starts not made, on, with the pretend provider', () => {
    expect(result.checks.firstComputer).toBe(true);
    expect(result.checks.secondComputerForTheSameBrick).toBe(false);
    expect(result.checks.computerForNobody).toBe(false);
    expect(result.checks.everyMachineState).toBe(true);
    expect(result.checks.startsNotMade).toEqual({ machine: 'none', enabled: true, provider: 'fake' });
  });

  it('holds a computer to the states, providers and sizes it may have', () => {
    expect(result.checks.anotherMachineState).toBe(false);
    expect(result.checks.anotherProvider).toBe(false);
    expect(result.checks.negativeFiles).toBe(false);
  });

  it('lets one writing job run or wait at a time, and read-only jobs and queued ones beside it', () => {
    expect(result.checks.firstJob).toBe(true);
    expect(result.checks.secondWriterRunning).toBe(false);
    expect(result.checks.secondWriterWaiting).toBe(false);
    expect(result.checks.readOnlyAlongside).toBe(true);
    expect(result.checks.queuedWriters).toBe(true);
    expect(result.checks.afterTheWriterEnds).toBe(true);
  });

  it('holds a job to the words it may use, and the mouse is the person’s only while the job waits for them', () => {
    for (const refused of ['anotherStatus', 'anotherQueuedFor', 'anotherEndedBy', 'anotherWaitingFor', 'anotherControl', 'personHasTheMouseWhileRunning', 'stepsBackwards', 'stepsOfNothing', 'jobForNobody']) {
      expect([refused, result.checks[refused]]).toEqual([refused, false]);
    }
    expect(result.checks.personHasTheMouseWhileWaiting).toBe(true);
  });

  it('keeps an effect outside the computer to one row per key on a job, with its kinds and states', () => {
    expect(result.checks.firstEffect).toBe(true);
    expect(result.checks.sameEffectTwice).toBe(false);
    expect(result.checks.sameKeyOnAnotherJob).toBe(true);
    expect(result.checks.everyKind).toBe(true);
    expect(result.checks.everyState).toBe(true);
    expect(result.checks.anotherKind).toBe(false);
    expect(result.checks.anotherState).toBe(false);
  });

  it('takes a Brick’s computer, jobs and effects with it when it is removed for good', () => {
    expect(result.afterBrickGone).toEqual({ computers: 0, jobs: 0, effects: 0 });
  });
});
