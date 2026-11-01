'use client';

import { isRecord, useCollection } from './use-collection';
import type { VoiceKeyCompany, VoiceKeySummary } from '@/lib/voice-keys';
import type { AiKeyKindInfo } from '@/lib/ai-key-kinds';

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

/** A speech company as /api/me/voice-keys lists it for Add a key. */
export function isVoiceCompany(value: unknown): value is VoiceKeyCompany {
  return (
    isRecord(value) &&
    typeof value.adapter === 'string' &&
    typeof value.label === 'string' &&
    typeof value.benefit === 'string' &&
    typeof value.step === 'string' &&
    typeof value.docs === 'string' &&
    typeof value.recognition === 'boolean' &&
    typeof value.speech === 'boolean'
  );
}

/** The speech companies a key can be added for (#749): the catalog's, that the server has a provider on for. */
export function useVoiceCompanies() {
  return useCollection<VoiceKeyCompany>('/api/me/voice-keys', 'companies', isVoiceCompany);
}

/**
 * A speech company drawn like a provider on Add a key: the same card in step 1 and the same setup card in step 2. It is hosted,
 * wants an API key and no address, and has no regions.
 */
export function voiceCompanyKind(company: VoiceKeyCompany): AiKeyKindInfo {
  return {
    kind: company.adapter,
    label: company.label,
    group: 'hosted',
    benefit: company.benefit,
    logo: company.logo ?? undefined,
    plainIcon: 'chip',
    steps: [{ text: company.step }],
    providerType: 'openai',
    address: 'none',
    apiKey: 'required',
    docs: company.docs,
    protocol: 'openai',
    auth: 'bearer',
    typedEndpointSuffix: '',
    keyCheck: { type: 'models' },
    modelId: 'as-is',
    tier: 'named',
  };
}
