import { ADDRESS_PROBLEM_TEXT, AddressError, checkPublicHttpsUrl, safeGet, safeRequest } from '@/lib/ai-key-fetch';
import { authHeaders, kindInfo, typedEndpoint, writeModelId, type AiKeyKind, type AiKeyKindInfo } from '@/lib/ai-key-kinds';

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
  return { ok: true, target: { info, endpoint: typedEndpoint(info, origin), modelsUrl: `${origin}/v1/models` } };
}

/** What a key may be made of (visible ASCII, no spaces): anything else cannot go in an Authorization header. */
export const KEY_CHARACTERS = /^[\x21-\x7e]{1,512}$/;
export const KEY_LOOKS_WRONG = 'That key doesn’t look right. Paste it again.';

/** OpenRouter's model list is well over the default cap, so a list may be a few MB. */
const MODEL_LIST_MAX_BYTES = 5_000_000;

/**
 * A provider whose model list is public (OpenRouter) still gets a 200 for a wrong key. Its key-info addresses do check the
 * key; only a clear 401/403 from one counts, so a path it doesn't have (404) or a hiccup never blocks a good key.
 */
async function keyInfoRejectsKey(base: string, paths: string[], apiKey: string): Promise<boolean> {
  for (const path of paths) {
    try {
      const checked = await checkPublicHttpsUrl(`${base}${path}`);
      const result = await safeGet(checked, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!result.ok) return false;
      if (result.status === 401 || result.status === 403) return true;
      if (result.status !== 404) return false;
    } catch {
      return false;
    }
  }
  return false;
}

export type LoadModelsResult = { ok: true; models: string[] } | { ok: false; message: string };

/**
 * Why a check failed, for deciding what to do about it: nobody answered, the provider said no, it was too busy to say
 * (a 429: it answered, so the key is neither proven good nor bad), it has no credit left (402), the model is not there
 * (a chat call's 404), or something else.
 */
export type ProbeFailure = 'unreachable' | 'rejected' | 'busy' | 'credit' | 'gone' | 'other';
export type ProbeModelsResult = { ok: true; models: string[] } | { ok: false; message: string; reason: ProbeFailure };

const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|transcribe|image|audio|realtime|guard|safety/i;

/** One model id as the bot server will use it. Gemini lists "models/gemini-flash-latest" but takes "gemini-flash-latest". */
export function cleanModelId(raw: string, kind: AiKeyKind): string {
  return writeModelId(raw, kind);
}

/** Tidy a provider's list: plain ids, no duplicates, chat models first by name. */
export function cleanModelIds(ids: string[], kind: AiKeyKind): string[] {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = cleanModelId(raw, kind);
    if (id && id.length <= 255 && !NOT_CHAT.test(id)) seen.add(id);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Like loadModels, and also says why it failed (the key health check needs that; a person only needs the sentence). */
export async function probeModels(input: KeyTargetInput & { apiKey?: unknown }): Promise<ProbeModelsResult> {
  const resolved = keyTarget(input);
  if (!resolved.ok) return { ...resolved, reason: 'other' };
  const { info, modelsUrl } = resolved.target;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (info.apiKey === 'required' && !apiKey) return { ok: false, message: 'Paste your API key first.', reason: 'other' };
  // A header can only carry plain visible characters: a pasted smart quote or zero-width space would make Node throw
  if (apiKey && !KEY_CHARACTERS.test(apiKey)) return { ok: false, message: KEY_LOOKS_WRONG, reason: 'other' };

  let checked;
  try {
    checked = await checkPublicHttpsUrl(modelsUrl);
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: ADDRESS_PROBLEM_TEXT[error.problem], reason: error.problem === 'unresolved' ? 'unreachable' : 'other' };
    return { ok: false, message: 'That address can’t be used.', reason: 'other' };
  }

  const result = await safeGet(checked, { headers: authHeaders(info, apiKey), maxBytes: MODEL_LIST_MAX_BYTES });
  if (!result.ok) {
    if (result.reason === 'too-large') return { ok: false, message: 'It answered, but not like an AI server.', reason: 'other' };
    return {
      ok: false,
      reason: 'unreachable',
      message:
        info.group === 'own-computer'
          ? 'It didn’t answer. Is the server running and the tunnel up?'
          : `${info.label} didn’t answer. Try again in a moment.`,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      reason: 'rejected',
      message:
        info.group === 'own-computer'
          ? 'The server asked for a key, or didn’t accept the one you gave.'
          : `${info.label} didn’t accept this key.`,
    };
  }
  if (result.status === 429) {
    return { ok: false, reason: 'busy', message: `${info.label} is busy right now. Try again in a moment.` };
  }
  if (result.status !== 200) return { ok: false, message: `It answered with an error (${result.status}).`, reason: result.status >= 500 ? 'unreachable' : 'other' };
  if (info.keyCheck.type === 'key-info' && info.base && apiKey && (await keyInfoRejectsKey(info.base, info.keyCheck.paths, apiKey))) {
    return { ok: false, message: `${info.label} didn’t accept this key.`, reason: 'rejected' };
  }

  let ids: string[] = [];
  try {
    const data: unknown = JSON.parse(result.body);
    const list = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : null;
    if (!Array.isArray(list)) throw new Error('shape');
    ids = list.map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : null)).filter((id): id is string => typeof id === 'string');
  } catch {
    return { ok: false, message: 'It answered, but not like an AI server.', reason: 'other' };
  }
  const models = cleanModelIds(ids, info.kind);
  if (models.length === 0) {
    return {
      ok: false,
      reason: 'other',
      message: info.group === 'own-computer' ? 'It answered, but no model is loaded. Load one in your server first.' : `${info.label} has no models for this key.`,
    };
  }
  return { ok: true, models };
}

/**
 * Asks the key's provider for one tiny reply from the saved model. A model list can answer while chat does not (the model
 * was removed, chat credit ran out), so this is what proves a key that went Down on failed replies works again.
 */
export async function probeChat(input: KeyTargetInput & { apiKey?: unknown; model: string }): Promise<{ ok: true } | { ok: false; message: string; reason: ProbeFailure }> {
  const resolved = keyTarget(input);
  if (!resolved.ok) return { ...resolved, reason: 'other' };
  const { info, modelsUrl } = resolved.target;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKey && !KEY_CHARACTERS.test(apiKey)) return { ok: false, message: KEY_LOOKS_WRONG, reason: 'other' };
  let checked;
  try {
    checked = await checkPublicHttpsUrl(modelsUrl.replace(/\/models$/, '/chat/completions'));
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: ADDRESS_PROBLEM_TEXT[error.problem], reason: error.problem === 'unresolved' ? 'unreachable' : 'other' };
    return { ok: false, message: 'That address can’t be used.', reason: 'other' };
  }
  const result = await safeRequest(checked, {
    method: 'POST',
    headers: authHeaders(info, apiKey),
    body: { model: input.model, messages: [{ role: 'user', content: 'Say ok.' }], stream: false, [info.tokenLimitField ?? 'max_tokens']: 16 },
    timeoutMs: 30_000,
    maxBytes: 200_000,
  });
  if (!result.ok) return { ok: false, reason: 'unreachable', message: `${info.label} didn’t answer. Try again in a moment.` };
  if (result.status >= 200 && result.status < 300) return { ok: true };
  if (result.status === 401 || result.status === 403) return { ok: false, reason: 'rejected', message: `${info.label} didn’t accept this key.` };
  if (result.status === 429) return { ok: false, reason: 'busy', message: `${info.label} is busy right now. Try again in a moment.` };
  if (result.status === 402) return { ok: false, reason: 'credit', message: `${info.label} says this key is out of credit.` };
  if (result.status === 404) return { ok: false, reason: 'gone', message: `${info.label} no longer has the model ${input.model}.` };
  return {
    ok: false,
    reason: result.status >= 500 ? 'unreachable' : 'other',
    message: `${info.label} lists its models, but a chat call to ${input.model} failed (${result.status}). Check the model.`,
  };
}

export async function loadModels(input: KeyTargetInput & { apiKey?: unknown }): Promise<LoadModelsResult> {
  const result = await probeModels(input);
  return result.ok ? result : { ok: false, message: result.message };
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
