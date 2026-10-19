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
