import type { VoiceKeySummary } from '@/lib/voice-keys';
import { RECHECK_MINUTES } from '@/lib/key-recheck';
import { count } from '../../components/ds';
import { DOWN_PHRASE, names, sinceText } from './key-text';

/** The words for a voice key on the AI keys page (#749). */

export type VoiceLent = VoiceKeySummary['lentTo'][number];

/** What a key does: "Listens", "Speaks" or "Listens and speaks". */
export const voiceDoes = (key: Pick<VoiceKeySummary, 'recognition' | 'speech'>) =>
  key.recognition && key.speech ? 'Listens and speaks' : key.recognition ? 'Listens' : 'Speaks';

/** "ElevenLabs · Listens and speaks · 5 models · ends in 7c1d" */
export function describeVoice(key: VoiceKeySummary): string {
  return [key.company, voiceDoes(key), count(key.models.length, 'model', 'models'), key.last4 ? `ends in ${key.last4}` : null].filter(Boolean).join(' · ');
}

/** The bots on a key across the universes it is lent to, once each. */
export const voiceBotNames = (key: VoiceKeySummary) => [...new Set(key.lentTo.flatMap((lent) => lent.bots.map((bot) => bot.name)))];

/** What its bots do while the key is down. */
export function repliesInText(bots: string[]): string {
  return bots.length === 0 ? '' : `${names(bots)} ${bots.length === 1 ? 'replies' : 'reply'} in text until it’s back.`;
}

/** The sentence under a Down voice key: since when, why, what its bots do meanwhile, and how often it is tried again. */
export function voiceDownText(key: VoiceKeySummary): string {
  const meanwhile = repliesInText(voiceBotNames(key));
  return `Down since ${sinceText(key.health.downSince ?? new Date().toISOString())}: ${key.company} ${DOWN_PHRASE[key.health.downReason ?? 'stopped']}.${meanwhile ? ` ${meanwhile}` : ''} Universe checks again, at most every ${RECHECK_MINUTES} minutes, whenever a bot needs it, and switches back as soon as the key answers.`;
}

/** The line under "If this is down" for a voice key: there is no other voice to move to. */
export const VOICE_IF_DOWN = 'Bots reply in text until it’s back. No other voice is used.';

/** "All models", or "Only Scribe v1, Eleven Flash v2.5" for a lend that names some. */
export function lentModelsLine(key: VoiceKeySummary, lent: VoiceLent): string {
  if (!lent.models) return 'All models';
  const label = (entry: string) => key.models.find((model) => `${model.kind}:${model.id}` === entry);
  return `Only ${lent.models.map((entry) => label(entry)?.label || label(entry)?.id || entry.slice(entry.indexOf(':') + 1)).join(', ')}`;
}

/** One bot under a lend: "Sales Researcher · Eleven Flash v2.5 · 186 voice replies". */
export const voiceBotLine = (bot: VoiceLent['bots'][number]) => [bot.name, bot.model, count(bot.voiceReplies, 'voice reply', 'voice replies')].filter(Boolean).join(' · ');
