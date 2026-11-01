'use client';

import { isRecord, useCollection } from './use-collection';
import type { VoiceKeySummary } from '@/lib/voice-keys';

/** A voice key as /api/me/voice-keys lists it: told apart from a text key by its adapter, health and voice replies. */
export function isVoiceKey(value: unknown): value is VoiceKeySummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.adapter === 'string' &&
    Array.isArray(value.models) &&
    Array.isArray(value.lentTo) &&
    isRecord(value.month) &&
    typeof value.month.voiceReplies === 'number' &&
    isRecord(value.health) &&
    (value.health.status === 'working' || value.health.status === 'down')
  );
}

/** The caller's own voice keys (#749): loading, failed (with retry), or the list. */
export function useVoiceKeys() {
  return useCollection<VoiceKeySummary>('/api/me/voice-keys', 'keys', isVoiceKey);
}
