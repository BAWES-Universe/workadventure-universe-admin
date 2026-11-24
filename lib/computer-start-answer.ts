import type { Started } from '@/lib/computer';

/**
 * The start's answers and its key's issue time (round 8, GPT's seventh note, Opus's design A1/A2): pure, with no database, so the start route reads them the same way whatever is mocked around it.
 */

/**
 * Round 8, A2: how long after the person gave consent (the key's issue time: the moment of their message) a start with no live record may still make a job. An older key with no attempt row, or whose attempt ended with no
 * job, answers `stale_consent` and makes nothing: Brick asks the person whether to start it now (a new message, a new key). The attempt clean-up (a week) is far longer, so a pruned key is always past this window.
 */
export const CONSENT_WINDOW_MS = 6 * 60 * 60_000;
/**
 * Clock-skew allowance for a start key's issue time: a key issued up to and including this far AHEAD of the start's own moment (`began`, read when the request arrives) is accepted; one millisecond more is refused (400 `untimed_key`). Future
 * times are therefore not refused outright: a game clock a little ahead of Orbit's is normal. Measured against the start's own moment, so the answer does not depend on how long the request waits afterwards.
 */
export const ISSUE_SKEW_MS = 5 * 60_000;

/**
 * The issue time a timed start key carries (round 8, A2): `t<milliseconds in base 36>-<rest>`, the whole key still `^[A-Za-z0-9_-]{8,64}$`. Null for a key that carries none (the legacy format), or one whose time is
 * not a plausible moment.
 */
export function issuedOfKey(startKey: string): Date | null {
  const found = /^t([0-9a-z]{1,11})-./.exec(startKey);
  if (!found) return null;
  const ms = parseInt(found[1], 36);
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  // A number can be a safe integer and still beyond the range a Date can hold (8.64e15 ms): that is an Invalid Date, which is no moment at all (it would slip past a caller's "no issue time" check)
  const issued = new Date(ms);
  return Number.isNaN(issued.getTime()) ? null : issued;
}

/** The answer of a start as the bot server reads it (every refusal is HTTP 200 `{ ok: false, reason }`). One place, so a refusal kept on its attempt is the same body when it is given again. */
export function startAnswerBody(started: Started): Record<string, unknown> {
  // `continued`: the job carries on in the conversation of the job the header named ("try again"); absent, it is a fresh job (none was named)
  if (started.ok) return { ok: true, job: started.job, restoredFrom: started.restoredFrom, ...(started.continued ? { continued: true } : {}) };
  // A refusal given before under this key: exactly that answer again (round 8, A1)
  if (started.reason === 'kept') return started.body;
  // A rule that stopped it on the try itself (the pre-check only asks for a first millionth): the same shape as above, with the rule's words
  if (started.reason === 'rule') return { ok: false, reason: 'rule', rule: { id: null, why: null, leftMicros: null, words: started.words } };
  // A connected app would do it for less: nothing was started, and the Brick is told which one to use
  if (started.reason === 'cheaper_route') return { ok: false, reason: 'cheaper_route', app: started.app };
  // An earlier start of this person on this Brick that the game has not confirmed: nothing was made. It is not a refusal of the ask (it is the job the game asked for earlier): the oldest such job and the key it was made under. It acks nothing
  if (started.reason === 'earlier') return { ok: false, reason: 'earlier', job: started.job };
  // "Try again" of a job that cannot be carried on: nothing was made (finding 6). Why, and the person's own named job, so Brick can say it and offer "Start a new job"
  if (started.reason === 'cannot_continue') return { ok: false, reason: 'cannot_continue', why: started.why, ...(started.job ? { job: started.job } : {}) };
  return { ok: false, reason: started.reason };
}

