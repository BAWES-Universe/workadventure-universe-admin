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

/**
 * What to tell the person when an AI keys route says no. A 4xx carries a plain sentence meant for them; anything else
 * ("Internal server error", "Key not found") is a server word, so it is put plainly here instead.
 */
export function aiKeyError(status: number, error: unknown): string {
  if (status === 404) return 'That key isn’t there any more. Reload the page and try again.';
  if (status >= 400 && status < 500 && status !== 401 && typeof error === 'string' && error) return error;
  if (status === 401) return 'Sign in again, then try again.';
  return 'Something went wrong on our side. Try again.';
}
