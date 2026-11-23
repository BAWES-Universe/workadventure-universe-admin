import { NextRequest, NextResponse } from 'next/server';
import { brickJson } from '@/lib/brick-api';
import { notFound } from '@/lib/computer-api';
import type { ControlRefusal, Controlled } from '@/lib/computer-job-controls';

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
};

/** The answer of a job control: the computer as the page shows it, 404 for a Brick or job that is not the owner's, 409 with a `reason` the game reads for every other refusal. */
export function controlAnswer(request: NextRequest, result: Controlled): NextResponse {
  if (result.ok) return brickJson(request, { computer: result.view, ...(result.signInsKept === undefined ? {} : { signInsKept: result.signInsKept }) });
  if (result.reason === 'not_found') return notFound(request);
  return brickJson(request, { error: REFUSAL_WORDS[result.reason], reason: result.reason }, 409);
}

/** A job id as the routes take it. */
export const jobIdOk = (jobId: unknown): jobId is string => typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 40;
