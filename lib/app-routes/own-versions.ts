import type { UseResult } from '@/lib/app-adapter/types';

/**
 * Universe's own versions of Apps (spec "Paying for Apps", section 21). An App runs on Composio unless its key is HERE and the
 * version has passed its checks; this list is empty until an own version is really written, so today no App can be moved and
 * every one runs on Composio. Adding an own version is code, with tests: this file only says what such a version must carry.
 *
 * Never a fallback: a run takes one route from start to end. An own version that fails fails; it is never retried on Composio,
 * because both could bill.
 */

export interface OwnAppVersion {
  /** The App's key, the same as its ready-made key (gmail, notion...). */
  key: string;
  /** When it passed its checks (a date), shown to the super admin: "Our own version passed its checks on 12 Nov". */
  passedChecksOn: string;
  /** The checks a move needs. Every one must be true: a version that is not ready for one is not ready. */
  checks: {
    /** The same inputs go in and the same outputs come out as the Composio tools it replaces. */
    sameInputsAndOutputs: boolean;
    /** What happens on a failure or a timeout is handled the way the Composio route handles it (an unclear result is looked up, never repeated). */
    failureAndTimeout: boolean;
    /** The same permission and account rules apply: whose account, which Brick, which universe. */
    permissionAndAccountRules: boolean;
  };
  /** The most one tool run on this version costs us, in millionths of a dollar. Trusted and fixed in code: an App with no top price is not offered. */
  topPriceMicros: number | null;
  /** The tools it offers, by the same names the Composio route uses. */
  tools(): { name: string; description?: string }[];
  /** One tool run for one person. A failure comes back as `ok: false`; it is never retried on another route. */
  use(input: { person: string; tool: string; arguments: Record<string, unknown>; providerAccountId: string | null; callId: string }): Promise<UseResult>;
}

/** The own versions that exist. Empty today. */
const OWN_VERSIONS: Record<string, OwnAppVersion> = {};

let override: Record<string, OwnAppVersion> | undefined;

/** For tests: own versions in place of the real (empty) list. Call with undefined to go back. */
export function setOwnVersionsForTests(versions: Record<string, OwnAppVersion> | undefined): void {
  override = versions;
}

export const ownVersionFor = (key: string): OwnAppVersion | null => (override ?? OWN_VERSIONS)[key] ?? null;

export const CHECK_WORDS: Record<keyof OwnAppVersion['checks'], string> = {
  sameInputsAndOutputs: 'the same inputs and outputs',
  failureAndTimeout: 'failure and timeout handling',
  permissionAndAccountRules: 'the same permission and account rules',
};

/** What stops an App moving to our own version, in plain words; empty when it can move. */
export function whyNotReady(key: string): string[] {
  const own = ownVersionFor(key);
  if (!own) return ['We have no version of our own for this App yet.'];
  const missing = (Object.keys(CHECK_WORDS) as (keyof OwnAppVersion['checks'])[]).filter((name) => own.checks[name] !== true).map((name) => `It has not passed ${CHECK_WORDS[name]}.`);
  if (own.topPriceMicros === null || !Number.isSafeInteger(own.topPriceMicros) || own.topPriceMicros < 0) missing.push('It has no top price.');
  return missing;
}
