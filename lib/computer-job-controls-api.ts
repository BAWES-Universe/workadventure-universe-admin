import { NextRequest, NextResponse } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { notFound } from '@/lib/computer-api';
import type { ControlRefusal, Controlled } from '@/lib/computer-job-controls';
import { COMMAND_HEADER, commandOf, type Command } from '@/lib/computer-commands';

/** What the person is told for each refusal (the game shows its own words by `reason`; this is for anyone reading the answer). */
const REFUSAL_WORDS: Record<Exclude<ControlRefusal, 'not_found'>, string> = {
  over: 'That job has already ended.',
  taken_over: 'You have the screen right now. Hand it back first, or stop the job.',
  ending: 'That job is already ending.',
  not_paused: 'That job is not paused.',
  not_queued: 'That job is not waiting in line.',
  allowance: "This month's computer time is used up, so it stays paused.",
  rule: 'It reached the spending limit you set, so it stays paused.',
  not_ready: 'Its browser could not be brought back yet. It will carry on by itself in a few minutes.',
  command_reused: 'That control was already used for something else. Try again.',
  not_ended: 'It has not ended yet. Ask again in a moment.',
  started: 'That job started after you were asked, so nothing was cancelled.',
};

/** The words for a control that came without its command id (or with one that is not a uuid). */
export const COMMAND_MISSING = `Every control needs its own command id (${COMMAND_HEADER}, a uuid).`;

/** The control's command id (finding 4, GPT round 6), or the 400 that refuses a control without one: every panel control carries the id made at the click, and a resend reuses it. */
export function needCommand(request: NextRequest): Command | NextResponse {
  const command = commandOf(request);
  if (command && command !== 'invalid') return command;
  return brickJson(request, { error: COMMAND_MISSING, reason: 'command_missing' }, 400);
}

/** The answer of a job control: the computer as the page shows it, 404 for a Brick or job that is not the owner's, 409 with a `reason` the game reads for every other refusal. */
export function controlAnswer(request: NextRequest, result: Controlled): NextResponse {
  if (result.ok) return brickJson(request, { computer: result.view, ...(result.signInsKept === undefined ? {} : { signInsKept: result.signInsKept }) });
  if (result.reason === 'not_found') return notFound(request);
  // A Cancel that did not finish ending the job is retryable, never a state of the job: the same command id asked again ends it (CodeRabbit on #1025, N11)
  if (result.reason === 'not_ended') return brickJson(request, { error: REFUSAL_WORDS.not_ended, reason: 'not_ended', retry: true }, 503);
  // The same command id for another control is the caller's mistake, never a state of the job
  return brickJson(request, { error: REFUSAL_WORDS[result.reason], reason: result.reason }, result.reason === 'command_reused' ? 400 : 409);
}

/** A job id as the routes take it. */
export const jobIdOk = (jobId: unknown): jobId is string => typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 40;
