import { ADDRESS_PROBLEM_TEXT, AddressError, checkPublicHttpsUrl, safeGet, safeRequest } from '@/lib/ai-key-fetch';
import { authHeaders, chatPath, chatProbeBody, hostedBase, kindInfo, typedEndpoint, writeModelId, type AiKeyKind, type AiKeyKindInfo } from '@/lib/ai-key-kinds';

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
  /** The region picked, for a kind that has them. */
  region: string | null;
}

export interface KeyTargetInput {
  kind?: unknown;
  address?: unknown;
  /** The region id, for a kind that has regions. */
  region?: unknown;
}

/** Works out where a key's provider lives, or says in plain words what is wrong with the address. */
export function keyTarget(input: KeyTargetInput): { ok: true; target: KeyTarget } | { ok: false; message: string } {
  const info = kindInfo(input.kind);
  if (!info) return { ok: false, message: 'Pick a type first.' };
  const typed = typeof input.address === 'string' ? input.address.trim() : '';
  if (info.address === 'none' || (info.address === 'optional' && !typed)) {
    const hosted = hostedBase(info, { region: input.region, address: input.address });
    if (!hosted.ok) return hosted;
    return { ok: true, target: { info, endpoint: hosted.base, modelsUrl: `${hosted.base}/models`, region: hosted.region } };
  }
  if (!typed) return { ok: false, message: 'Paste the https address of your server.' };
  let origin: string;
  try {
    // Only the name (and port) is kept: a pasted /v1 or path is dropped, so what the bot server calls is predictable.
    origin = new URL(typed).origin;
  } catch {
    return { ok: false, message: ADDRESS_PROBLEM_TEXT['not-https'] };
  }
  return { ok: true, target: { info, endpoint: typedEndpoint(info, origin), modelsUrl: `${origin}/v1/models`, region: null } };
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

export type LoadModelsResult = { ok: true; models: string[]; facts: ModelFactsById } | { ok: false; message: string };

/**
 * Why a check failed, for deciding what to do about it: nobody answered, the provider said no, it was too busy to say
 * (a 429: it answered, so the key is neither proven good nor bad), it has no credit left (402), the model is not there
 * (a chat call's 404), the provider took the key but refused the probe's own request (a 400, 413 or 422: it says nothing about
 * the key, the way a reply's 400 is not counted against it), or something else.
 */
export type ProbeFailure = 'unreachable' | 'rejected' | 'busy' | 'credit' | 'gone' | 'request' | 'other';
/** What a provider says about one model in its list, when it says: can it call tools, take images, how much can it read. */
export type ModelFacts = {
  tools?: boolean;
  vision?: boolean;
  context?: number;
};
export type ModelFactsById = Record<string, ModelFacts>;
export type ProbeModelsResult = { ok: true; models: string[]; facts: ModelFactsById } | { ok: false; message: string; reason: ProbeFailure };

/**
 * What a provider's 400 or 422 says when the problem is the model (it does not exist, or this key may not use it) and not the
 * request. Only these words count: a bare "invalid" does not, because a refused token limit says "invalid" too.
 */
const MODEL_REFUSED =
  /model_not_found|(unknown|unsupported|nonexistent|no such|invalid)\s+model|model[^.\n]{0,60}(does not exist|doesn't exist|not exist|not found|not supported|unsupported|not available|unavailable|no access|not have access|don't have access|do not have access|not allowed|permission|deprecated|decommissioned|retired)|(does not exist|not found|no access)[^.\n]{0,40}model/i;

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

/** What is saved on a key about its model: only the facts the provider gave. */
export function modelCaps(facts: ModelFactsById, model: string): ModelFacts {
  return facts[model] ?? {};
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmptyList = (value: unknown): value is unknown[] => Array.isArray(value) && value.length > 0;
const asBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

/**
 * What one entry of a provider's model list says about the model. A fact the provider leaves out is unknown, never "no":
 * OpenRouter names the parameters and input kinds a model takes, Mistral lists `capabilities`, Together `context_length`,
 * Groq `context_window`, Claude `capabilities.image_input` and `max_input_tokens`. A list that names parameters but not `tools` is saying the model cannot call tools.
 */
export function factsOf(entry: unknown): ModelFacts {
  if (!isRecord(entry)) return {};
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
  const architecture = isRecord(entry.architecture) ? entry.architecture : {};
  const tools = nonEmptyList(entry.supported_parameters) ? entry.supported_parameters.includes('tools') : asBoolean(capabilities.function_calling);
  // Claude: capabilities.image_input.supported
  const imageInput = isRecord(capabilities.image_input) ? asBoolean(capabilities.image_input.supported) : undefined;
  const vision = nonEmptyList(architecture.input_modalities) ? architecture.input_modalities.includes('image') : (asBoolean(capabilities.vision) ?? imageInput);
  const rawContext = entry.context_length ?? entry.max_context_length ?? entry.context_window ?? entry.max_input_tokens;
  const context = typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0 ? Math.round(rawContext) : undefined;
  const facts: ModelFacts = {};
  if (tools !== undefined) facts.tools = tools;
  if (vision !== undefined) facts.vision = vision;
  if (context !== undefined) facts.context = context;
  return facts;
}

/** Claude's list is paged, and a page may hold up to 1000 models. */
const ANTHROPIC_PAGE = 1000;
const ANTHROPIC_MAX_PAGES = 5;

/**
 * Claude's model list says `has_more` and a `last_id` to ask the next page from. The first page already proved the key;
 * a later page that fails just ends the list, so the models already read still show.
 */
async function morePages(modelsUrl: string, apiKey: string, info: AiKeyKindInfo, first: unknown[], firstBody: string): Promise<unknown[]> {
  const entries = [...first];
  let body = firstBody;
  for (let page = 1; page < ANTHROPIC_MAX_PAGES; page++) {
    let next: { has_more?: unknown; last_id?: unknown };
    try {
      next = JSON.parse(body);
    } catch {
      break;
    }
    if (next.has_more !== true || typeof next.last_id !== 'string') break;
    try {
      const checked = await checkPublicHttpsUrl(`${modelsUrl}?limit=${ANTHROPIC_PAGE}&after_id=${encodeURIComponent(next.last_id)}`);
      const result = await safeGet(checked, { headers: authHeaders(info, apiKey), maxBytes: MODEL_LIST_MAX_BYTES });
      if (!result.ok || result.status !== 200) break;
      const more: unknown = JSON.parse(result.body);
      const list = typeof more === 'object' && more !== null ? (more as { data?: unknown }).data : null;
      if (!Array.isArray(list) || list.length === 0) break;
      entries.push(...list);
      body = result.body;
    } catch {
      break;
    }
  }
  return entries;
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
    checked = await checkPublicHttpsUrl(info.protocol === 'anthropic' ? `${modelsUrl}?limit=${ANTHROPIC_PAGE}` : modelsUrl);
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
  if (result.status === 429 || result.status === 529) {
    return { ok: false, reason: 'busy', message: `${info.label} is busy right now. Try again in a moment.` };
  }
  if (result.status !== 200) return { ok: false, message: `It answered with an error (${result.status}).`, reason: result.status >= 500 ? 'unreachable' : 'other' };
  if (info.keyCheck.type === 'key-info' && apiKey && (await keyInfoRejectsKey(resolved.target.endpoint, info.keyCheck.paths, apiKey))) {
    return { ok: false, message: `${info.label} didn’t accept this key.`, reason: 'rejected' };
  }

  let entries: unknown[] = [];
  try {
    const data: unknown = JSON.parse(result.body);
    // Most providers answer { data: [...] }; some (Together) answer the bare array
    const list = Array.isArray(data) ? data : typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : null;
    if (!Array.isArray(list)) throw new Error('shape');
    entries = list;
    if (info.protocol === 'anthropic') entries = await morePages(modelsUrl, apiKey, info, entries, result.body);
  } catch {
    return { ok: false, message: 'It answered, but not like an AI server.', reason: 'other' };
  }
  const idOf = (entry: unknown): string | null => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : null);
  const models = cleanModelIds(entries.map(idOf).filter((id): id is string => id !== null), info.kind);
  if (models.length === 0) {
    return {
      ok: false,
      reason: 'other',
      message: info.group === 'own-computer' ? 'It answered, but no model is loaded. Load one in your server first.' : `${info.label} has no models for this key.`,
    };
  }
  const facts: ModelFactsById = {};
  // A set, not models.includes: a list can be thousands of entries long, and each one is looked up
  const listed = new Set(models);
  for (const entry of entries) {
    const id = idOf(entry);
    if (id === null) continue;
    const clean = cleanModelId(id, info.kind);
    const known = factsOf(entry);
    if (listed.has(clean) && Object.keys(known).length > 0) facts[clean] = known;
  }
  // What the provider's docs say about a model its list says nothing about; the list's own word wins
  for (const [id, documented] of Object.entries(info.knownFacts ?? {})) {
    if (listed.has(id)) facts[id] = { ...documented, ...facts[id] };
  }
  return { ok: true, models, facts };
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
    checked = await checkPublicHttpsUrl(`${modelsUrl.replace(/\/models$/, '')}${chatPath(info)}`);
  } catch (error) {
    if (error instanceof AddressError) return { ok: false, message: ADDRESS_PROBLEM_TEXT[error.problem], reason: error.problem === 'unresolved' ? 'unreachable' : 'other' };
    return { ok: false, message: 'That address can’t be used.', reason: 'other' };
  }
  const ask = (extra: Record<string, unknown>) =>
    safeRequest(checked, {
      method: 'POST',
      headers: authHeaders(info, apiKey),
      body: { ...chatProbeBody(info, input.model), ...extra },
      // A server on your own computer may load its model on the first call, which can take well over 30 seconds
      timeoutMs: info.group === 'own-computer' ? 120_000 : 30_000,
      maxBytes: 200_000,
    });
  let result = await ask({});
  // Alibaba's thinking models (open-source Qwen3 among them) refuse a non-streaming reply unless thinking is off. The bot server
  // handles that the same way when it asks for one-shot replies; the check must not call such a model broken.
  if (result.ok && result.status === 400 && /enable_thinking/i.test(result.body)) result = await ask({ enable_thinking: false });
  if (!result.ok) return { ok: false, reason: 'unreachable', message: `${info.label} didn’t answer. Try again in a moment.` };
  if (result.status >= 200 && result.status < 300) return { ok: true };
  if (result.status === 401 || result.status === 403) return { ok: false, reason: 'rejected', message: `${info.label} didn’t accept this key.` };
  if (result.status === 429 || result.status === 529) return { ok: false, reason: 'busy', message: `${info.label} is busy right now. Try again in a moment.` };
  // Claude says "out of credit" and "spend limit reached" as a plain 400; other providers' 400s are about the request
  if (result.status === 402 || (info.protocol === 'anthropic' && result.status === 400 && /credit balance|usage limits|billing/i.test(result.body))) return { ok: false, reason: 'credit', message: `${info.label} says this key is out of credit.` };
  if (result.status === 404) return { ok: false, reason: 'gone', message: `${info.label} no longer has the model ${input.model}.` };
  // Some providers answer a model they do not have, or one this key may not use, with a 400 or 422 instead of a 404
  if ((result.status === 400 || result.status === 422) && MODEL_REFUSED.test(result.body)) {
    return { ok: false, reason: 'gone', message: `${info.label} won’t give this key the model ${input.model}.` };
  }
  return {
    ok: false,
    reason: result.status >= 500 ? 'unreachable' : [400, 413, 422].includes(result.status) ? 'request' : 'other',
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
