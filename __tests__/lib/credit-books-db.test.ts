/**
 * The funding books against a real database (paying spec v3, acceptance tests 1, 2, 3, 4, 7, 8, 13, 14 and the books part of 12).
 * The scenarios run in their own process (PGlite cannot load inside Jest) and print one line; every check must be ok.
 * Set CREDIT_BOOKS_PG to a Postgres URL to run the same scenarios on real Postgres, with several connections.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Report = { kind: string; error?: string; checks: { name: string; ok: boolean; detail?: unknown }[] };

let report: Report;

beforeAll(() => {
  const run = spawnSync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(__dirname, '../helpers/run-credit-books.ts')], { encoding: 'utf8', timeout: 540_000, maxBuffer: 64 * 1024 * 1024 });
  const last = (run.stdout ?? '').trim().split('\n').pop() ?? '';
  // A scenario process that did not start, timed out or exited badly is a failure with its own words, never a report to be parsed
  if (run.error || run.status !== 0) {
    throw new Error(`The credit books scenarios did not finish cleanly (status ${run.status}, signal ${run.signal}${run.error ? `, ${run.error.message}` : ''}).\n${run.stderr?.slice(-2000) ?? ''}\n${last.slice(0, 800)}`);
  }
  try {
    report = JSON.parse(last) as Report;
  } catch {
    throw new Error(`The credit books scenarios printed nothing readable.\n${run.stderr?.slice(-2000) ?? ''}\n${last.slice(0, 500)}`);
  }
}, 560_000);

describe('the funding books on a real database', () => {
  it('runs every scenario to the end', () => {
    expect(report.error).toBeUndefined();
    expect(report.kind).not.toBe('crashed');
    expect(report.checks.length).toBeGreaterThan(100);
  });

  it('passes every check', () => {
    const failed = report.checks.filter((check) => !check.ok);
    // Names first and short: CI shows only the tail of the log, so the first failure's detail comes last
    const message = failed.length === 0 ? '' : `${failed.length} checks failed:\n${failed.slice(0, 15).map((check) => `- ${check.name.slice(0, 110)}`).join('\n')}\nfirst: ${JSON.stringify(failed[0].detail)?.slice(0, 500)}`;
    expect(message).toBe('');
  });
});
