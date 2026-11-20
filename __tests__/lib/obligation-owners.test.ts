/**
 * One owner for each money obligation (GPT money review O6, "across mixed-version workers"). While a release rolls out, the old and the new version run
 * side by side on one database, so an obligation can only be kept once if its owner is a SINGLE piece of code that claims its record in the database (a
 * lock, a unique key, a lease or a generation), never a process, a version or a timer. This test pins who may write each obligation's record: a second
 * writer, in a file or through a raw statement, fails here until it is added on purpose (and to docs/RELEASE-0.5.0-MIGRATIONS.md, which says how each is
 * claimed). No database needed.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '../..');

function* sources(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(relative);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield relative;
  }
}
const files = [...sources('lib'), ...sources('app')].map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));

/** The files that write this table: through its Prisma model, or by a raw INSERT / UPDATE / DELETE statement. */
const writers = (model: string, table: string): string[] => {
  const viaModel = new RegExp(`\\.${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\b`);
  const viaSql = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"?${table}"?\\b`);
  return files.filter(({ text }) => viaModel.test(text) || viaSql.test(text)).map(({ file }) => file).sort();
};
const callers = (name: string): string[] => files.filter(({ text }) => new RegExp(`(?<![\\w.])${name}\\(`).test(text.replace(new RegExp(`(async )?function ${name}\\(`, 'g'), ''))).map(({ file }) => file).sort();
const countIn = (file: string, pattern: RegExp): number => (files.find((one) => one.file === file)?.text.match(pattern) ?? []).length;

/** model, table, and the only files that may write it. */
const OWNERS: Array<[string, string, string[], string]> = [
  ['instantRun', 'instant_runs', ['lib/instant/executor.ts'], 'an Instant run: its holds, its send, its settlement (one advisory lock per run)'],
  ['instantRefund', 'instant_refunds', ['lib/instant/executor.ts'], 'an Instant give-back owed (a unique key per give-back; retried until the books confirm)'],
  ['meterReservation', 'meter_reservations', ['lib/meter-allowance.ts'], 'a lease on someone’s allowance (a unique key per lease; the pool lock is held to take, renew, settle or release it)'],
  ['taskReceipt', 'task_receipts', ['lib/brick-purge.ts', 'lib/task-receipts.ts'], 'a receipt that must always settle (a lock per task, a lease and a generation; a purged Brick’s open receipts are ended by its purge)'],
  ['appKeyRequest', 'app_key_requests', ['lib/app-direct/connect.ts', 'lib/brick-purge.ts'], 'tries on a key form (the form row and its reserved epoch; a purged Brick’s forms are removed by its purge)'],
  ['appPageOrder', 'app_page_orders', ['lib/app-direct/pay.ts'], 'a checkout order (one order per page, buyer and wish; moves recorded in order events)'],
  ['appPageOrderEvent', 'app_page_order_events', ['lib/app-direct/pay.ts'], 'each move an order made'],
  ['computerArchive', 'computer_archives', ['lib/computer-archives.ts', 'lib/computer-cold.ts'], 'a stored copy and the deletion of its object (taken for deletion before the object is touched; the cold sweep marks a proof that failed inside its own claim)'],
  ['brickPurge', 'brick_purges', ['lib/brick-purge.ts'], 'what is still to delete outside for a deleted Brick'],
  ['botFileRemoval', 'bot_file_removals', ['lib/brick-files.ts', 'lib/brick-purge.ts'], 'a saved file still to delete from the bucket (a unique key per file)'],
  ['voiceNoteCleanup', 'voice_note_cleanups', ['lib/voice-note-cleanups.ts'], 'a voice note’s files still to delete at the provider (a lease per row)'],
  ['botsAiUsage', 'bots_ai_usage', ['app/api/bots/ai-usage/route.ts'], 'a usage report (one id per report, written once)'],
  ['computerEffect', 'computer_effects', ['lib/computer.ts'], 'an effect a computer job planned outside (planned before it is sent, never repeated)'],
  ['meterGrant', 'meter_grants', ['lib/meter-grants.ts'], 'extra usage granted to someone (a unique key per grant)'],
  ['appUse', 'app_uses', ['lib/app-uses.ts'], 'an App use counted against a connection (a lock per connection and universe)'],
  // A job has several column families, each owned by one file (state and ending, model calls and claims, the report to the person, visits)
  ['computerJob', 'computer_jobs', ['lib/computer-broker.ts', 'lib/computer-giveback.ts', 'lib/computer-report.ts', 'lib/computer-visits.ts', 'lib/computer.ts'], 'a computer job (split by what is written: ending and time in computer.ts, calls and claims in computer-broker.ts, the give-back decision’s mark on the job in computer-giveback.ts, the report in computer-report.ts, visits in computer-visits.ts)'],
];

describe('who may write each obligation’s record', () => {
  it.each(OWNERS)('%s (%s): only %j', (model, table, owners) => {
    expect(writers(model, table)).toEqual([...owners].sort());
  });

  it('every obligation is listed on the docs page with how it is claimed', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/RELEASE-0.5.0-MIGRATIONS.md'), 'utf8');
    for (const [, table] of OWNERS) expect(doc).toContain(`\`${table}\``);
  });
});

describe('one writer for what many paths lead to', () => {
  it('an Instant run’s meter line is written by ONE function, whichever path settles, confirms or repairs the run', () => {
    // The builder of the line and the writer that inserts or corrects it live in lib/instant/report.ts and nowhere else
    expect(callers('instantEventOf')).toEqual(['lib/instant/report.ts']);
    expect(callers('reportInstantRunIn')).toEqual(['lib/instant/executor.ts', 'lib/instant/report.ts']);
    expect(files.filter(({ file, text }) => file.startsWith('lib/instant/') && /\brecordMeterEvent\(/.test(text)).map(({ file }) => file)).toEqual(['lib/instant/report.ts']);
    // The first insert (a settlement) goes through the same writer as the later confirmation and repair
    expect(countIn('lib/instant/executor.ts', /reportInstantRunIn\(/g)).toBeGreaterThanOrEqual(4);
    expect(countIn('lib/instant/executor.ts', /instantEventOf|recordMeterEvent/g)).toBe(0);
  });

  it('a computer job’s credit is given back by ONE function, whoever notices the end (the end, a late call, the sweep)', () => {
    expect(callers('giveBackComputerCredit')).toEqual(['lib/computer-calls.ts']);
    expect(countIn('lib/computer-calls.ts', /giveBackComputerCredit\(/g)).toBe(1);
    // The calls of a job are given back by the one function in computer-calls.ts (safe to ask twice); the end, the sweep and the give-back decision all ask it
    expect(callers('giveBackModelCalls')).toEqual(['lib/computer-calls.ts', 'lib/computer-giveback.ts', 'lib/computer.ts']);
  });

  it('a stale or repeated receipt close is settled by ONE function', () => {
    expect(callers('settleCheckingReceipts')).toEqual(['lib/instant/sweep.ts']);
    expect(files.filter(({ file, text }) => file !== 'lib/task-receipts.ts' && /\.taskReceipt\.(update|updateMany|create|createMany|upsert)/.test(text)).map(({ file }) => file)).toEqual(['lib/brick-purge.ts']);
  });
});
