import { lendModelId } from '@/lib/voice-lend-model';
import type { VoiceModel } from '@/lib/voice-providers';

/**
 * The models taken off a voice provider by hand, as "kind:id" (voice discovery, 8 Nov 2026): the company's own list fills the rest
 * in on its own (lib/voice-discovery.ts), and these stay off. Free of server code.
 */
export function readHiddenModels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 300) : [];
}

/**
 * The hidden list after a hand change of the models: a model taken off is hidden, one added back is not. Null when none are hidden.
 */
export function hiddenAfter(before: VoiceModel[], after: VoiceModel[], hidden: unknown): string[] | null {
  const kept = new Set(after.map(lendModelId));
  const had = new Set(before.map(lendModelId));
  const next = new Set(readHiddenModels(hidden));
  for (const id of had) if (!kept.has(id)) next.add(id);
  for (const id of kept) next.delete(id);
  return next.size > 0 ? [...next] : null;
}

