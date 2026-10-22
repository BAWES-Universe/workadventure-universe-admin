'use client';

import { isRecord, useCollection } from './use-collection';
import type { AiKeySummary } from '@/lib/ai-keys';

function isAiKey(value: unknown): value is AiKeySummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && isRecord(value.month) && Array.isArray(value.lentTo) && (value.status === 'working' || value.status === 'down') && (value.ifDown === 'universe-ai' || value.ifDown === 'stop');
}

/** The caller's own AI keys (#374): loading, failed (with retry), or the list. */
export function useAiKeys() {
  return useCollection<AiKeySummary>('/api/me/ai-keys', 'keys', isAiKey);
}

/** A failure we already put plainly for the person, so it is shown as it is. */
export class AiKeyFailure extends Error {}

/** The server's catch-all words: never shown, a plain sentence is shown instead. */
const SERVER_WORDS = 'Internal server error';

/**
 * What to tell the person when an AI keys route says no. A 4xx carries a plain sentence meant for them, and so does a
 * 5xx that names its cause ("Keys can’t be saved on this server yet"); the catch-all "Internal server error" and
 * "Key not found" are server words, so they are put plainly here instead.
 */
export function aiKeyError(status: number, error: unknown): string {
  if (status === 404) return 'That key isn’t there any more. Reload the page and try again.';
  if (status === 401) return 'Sign in again, then try again.';
  if (status >= 400 && typeof error === 'string' && error && error !== SERVER_WORDS) return error;
  return 'Something went wrong on our side. Try again.';
}

/**
 * What a failed AI keys action shows: our own plain sentence, or, when the request never got an answer (offline, the
 * browser's "Failed to fetch"), a plain line about the connection instead of the browser's words.
 */
export function aiKeyFailureText(error: unknown): string {
  if (error instanceof AiKeyFailure) return error.message;
  return 'We couldn’t reach Universe. Check your connection and try again.';
}
