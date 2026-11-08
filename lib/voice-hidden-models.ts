import { lendModelId } from '@/lib/voice-lend-model';
import type { VoiceModel } from '@/lib/voice-providers';

/** The models taken off by hand, as kept ("kind:id"); anything else in the column is left out. */
export function readHiddenModels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 300) : [];
}

/**
 * The models and the ones kept off after a change to a provider's models. Only the models named in `takenOff` ("kind:id") are kept
 * off: the company's list never adds those back. A model the provider has that the change doesn't mention, one the company's list
 * added while the page was open, is kept at the end rather than taken off. A model added back by hand comes off the hidden list.
 * Without `takenOff` the change replaces the models as sent and nothing new is kept off.
 */
export function modelChange(before: VoiceModel[], sent: VoiceModel[], takenOff: string[] | undefined, hidden: unknown): { models: VoiceModel[]; hidden: string[] | null } {
  const off = new Set(takenOff ?? []);
  const named = new Set(sent.map(lendModelId));
  const models = takenOff === undefined ? sent : [...sent, ...before.filter((model) => !named.has(lendModelId(model)) && !off.has(lendModelId(model)))];
  const kept = new Set(models.map(lendModelId));
  const next = new Set([...readHiddenModels(hidden), ...off]);
  for (const id of kept) next.delete(id);
  return { models, hidden: next.size > 0 ? [...next] : null };
}
