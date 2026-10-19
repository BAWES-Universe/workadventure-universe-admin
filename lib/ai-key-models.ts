import { ADDRESS_PROBLEM_TEXT, AddressError, checkPublicHttpsUrl, safeGet } from '@/lib/ai-key-fetch';
import { kindInfo, type AiKeyKind, type AiKeyKindInfo } from '@/lib/ai-key-kinds';

/**
 * Asks a key's provider which models it has. This is also the check that it answers: Add key stays off until the list
 * came back. Every call goes through `safeGet`, so an address a person typed is never reached on a private network.
 */

export interface KeyTarget {
  info: AiKeyKindInfo;
  /** What is saved as the provider's endpoint: the typed address's origin for own-computer kinds, the base for hosted. */
  endpoint: string;
  /** The model list address. */
  modelsUrl: string;
}

export interface KeyTargetInput {
  kind?: unknown;
  address?: unknown;
}

/** Works out where a key's provider lives, or says in plain words what is wrong with the address. */
export function keyTarget(input: KeyTargetInput): { ok: true; target: KeyTarget } | { ok: false; message: string } {
  const info = kindInfo(input.kind);
  if (!info) return { ok: false, message: 'Pick a type first.' };
  const typed = typeof input.address === 'string' ? input.address.trim() : '';
  if (info.address === 'none' || (info.address === 'optional' && !typed)) {
    return { ok: true, target: { info, endpoint: info.base!, modelsUrl: `${info.base}/models` } };
  }
  if (!typed) return { ok: false, message: 'Paste the https address of your server.' };
  let origin: string;
  try {
    // Only the name (and port) is kept: a pasted /v1 or path is dropped, so what the bot server calls is predictable.
    origin = new URL(typed).origin;
  } catch {
    return { ok: false, message: ADDRESS_PROBLEM_TEXT['not-https'] };
  }
  if (info.kind === 'nim') return { ok: true, target: { info, endpoint: `${origin}/v1`, modelsUrl: `${origin}/v1/models` } };
  return { ok: true, target: { info, endpoint: origin, modelsUrl: `${origin}/v1/models` } };
}

/** What a key may be made of (visible ASCII, no spaces): anything else cannot go in an Authorization header. */
export const KEY_CHARACTERS = /^[\x21-\x7e]{1,512}$/;
export const KEY_LOOKS_WRONG = 'That key doesn’t look right. Paste it again.';

/** OpenRouter's model list is well over the default cap, so a list may be a few MB. */
const MODEL_LIST_MAX_BYTES = 5_000_000;

export type LoadModelsResult = { ok: true; models: string[] } | { ok: false; message: string };

const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|transcribe|image|audio|realtime|guard|safety/i;

/** Tidy a provider's list: plain ids, no duplicates, chat models first by name. */
export function cleanModelIds(ids: string[], kind: AiKeyKind): string[] {
  const seen = new Set<string>();
  for (const raw of ids) {
    // Gemini lists "models/gemini-flash-latest" but takes "gemini-flash-latest".
    const id = (kind === 'gemini' ? raw.replace(/^models\//, '') : raw).trim();
    if (id && id.length <= 255 && !NOT_CHAT.test(id)) seen.add(id);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export async function loadModels(input: KeyTargetInput & { apiKey?: unknown }): Promise<LoadModelsResult> {
  const resolved = keyTarget(input);
  if (!resolved.ok) return resolved;
  const { info, modelsUrl } = resolved.target;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (info.apiKey === 'required' && !apiKey) return { ok: false, message: 'Paste your API key first.' };
  // A header can only carry plain visible characters: a pasted smart quote or zero-width space would make Node throw
  if (apiKey && !KEY_CHARACTERS.test(apiKey)) return { ok: false, message: KEY_LOOKS_WRONG };

  let checked;
  try {
    checked = await checkPublicHttpsUrl(modelsUrl);
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: ADDRESS_PROBLEM_TEXT[error.problem] };
    return { ok: false, message: 'That address can’t be used.' };
  }

  const result = await safeGet(checked, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, maxBytes: MODEL_LIST_MAX_BYTES });
  if (!result.ok) {
    if (result.reason === 'too-large') return { ok: false, message: 'It answered, but not like an AI server.' };
    return {
      ok: false,
      message:
        info.group === 'own-computer'
          ? 'It didn’t answer. Is the server running and the tunnel up?'
          : `${info.label} didn’t answer. Try again in a moment.`,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      message:
        info.group === 'own-computer'
          ? 'The server asked for a key, or didn’t accept the one you gave.'
          : `${info.label} didn’t accept this key.`,
    };
  }
  if (result.status !== 200) return { ok: false, message: `It answered with an error (${result.status}).` };

  let ids: string[] = [];
  try {
    const data: unknown = JSON.parse(result.body);
    const list = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : null;
    if (!Array.isArray(list)) throw new Error('shape');
    ids = list.map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : null)).filter((id): id is string => typeof id === 'string');
  } catch {
    return { ok: false, message: 'It answered, but not like an AI server.' };
  }
  const models = cleanModelIds(ids, info.kind);
  if (models.length === 0) {
    return {
      ok: false,
      message: info.group === 'own-computer' ? 'It answered, but no model is loaded. Load one in your server first.' : `${info.label} has no models for this key.`,
    };
  }
  return { ok: true, models };
}

const attempts = new Map<string, number[]>();

/** A person may check or add a key about 20 times a minute: these routes call out to addresses they typed. */
export function allowKeyAttempt(userId: string, now = Date.now()): boolean {
  const recent = (attempts.get(userId) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= 20) {
    attempts.set(userId, recent);
    return false;
  }
  recent.push(now);
  attempts.set(userId, recent);
  return true;
}
