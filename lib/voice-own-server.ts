import { ADDRESS_PROBLEM_TEXT, AddressError, checkPublicHttpsUrl, parsePublicHttpsUrl, safeGet, type CheckedAddress } from '@/lib/ai-key-fetch';
import { KEY_CHARACTERS, KEY_LOOKS_WRONG } from '@/lib/ai-key-models';
import type { VoiceModel } from '@/lib/voice-providers';

/**
 * A speech server a person runs on their own computer (game #1874), reached through an https address such as a cloudflared tunnel,
 * the way chat reaches LM Studio. Any server that answers the OpenAI speech shape works: Speaches (Whisper listening, Kokoro and
 * Piper speaking), Kokoro-FastAPI, a Whisper of their own. It is one entry, not a company: no project is named in the catalog and
 * none is ranked over another; the steps only use two as examples.
 *
 * What the game's worker calls, at the address saved with the key (`<origin>/v1`):
 * - listening: POST /audio/transcriptions, one recording each time the person pauses (so no words show while they talk);
 * - speaking: POST /audio/speech, raw audio.
 * Orbit calls only the free lists, with the same guard as an own-computer chat key (lib/ai-key-fetch.ts): https, a name, every
 * address it gives public, the connection pinned to the checked addresses, no redirect followed.
 *
 * What a model does (listens or speaks) is read from the server's own list when each model says its task (Speaches lists
 * `automatic-speech-recognition` or `text-to-speech`). When a model doesn't say, the person picks. Nothing is guessed from a model's name.
 */

/** The adapter the game's worker runs this with. */
export const OWN_SPEECH_ADAPTER = 'openai-compatible';
export const OWN_SPEECH_LABEL = 'Any OpenAI-compatible speech server';
export const OWN_SPEECH_NAME = 'My speech server';

/** Starts at the address a person pastes; kept as `<origin>/v1`. */
export const isOwnSpeechAdapter = (adapter: unknown): adapter is typeof OWN_SPEECH_ADAPTER => adapter === OWN_SPEECH_ADAPTER;

/** What step 2 of Add a key shows, as the chat servers' steps do. */
export const OWN_SPEECH_ENTRY = {
  adapter: OWN_SPEECH_ADAPTER,
  label: OWN_SPEECH_LABEL,
  benefit: 'Speaches, Kokoro-FastAPI, your own Whisper: anything that answers /v1/audio.',
  steps: [
    {
      text: 'Start the server. Speaches listens and speaks (port 8000); Kokoro-FastAPI speaks (port 8880). For Speaches:',
      code: 'docker run -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu',
    },
    { text: 'Make it reachable from the web. Run (use 8880 for Kokoro-FastAPI):', code: 'cloudflared tunnel --url http://localhost:8000' },
    { text: 'Paste the https address it prints below, and a key if the server asks for one.' },
  ],
} as const;

export type OwnSpeechStep = { text: string; code?: string };

/** How long the server has to answer, and how big a list may be. */
export const OWN_SPEECH_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 2_000_000;
/** More models or voices than this is not a list a person can pick through. */
export const MAX_OWN_MODELS = 100;
export const MAX_OWN_VOICES = 1000;

const WORDS = {
  unreachable: 'It didn’t answer. Is the server running and the tunnel up?',
  refused: 'The server asked for a key, or didn’t accept the one you gave.',
  notSpeech: 'It answered, but not like an AI server.',
  none: 'It answered, but it lists no models. Load one in your server first.',
} as const;

/** The address saved for a key: the origin typed, with `/v1`. A pasted path is dropped, so what the worker calls is predictable. */
export function ownSpeechEndpoint(raw: unknown): { ok: true; endpoint: string } | { ok: false; message: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, message: 'Paste the https address of your server.' };
  try {
    return { ok: true, endpoint: `${parsePublicHttpsUrl(raw).origin}/v1` };
  } catch (error) {
    return { ok: false, message: error instanceof AddressError ? ADDRESS_PROBLEM_TEXT[error.problem] : ADDRESS_PROBLEM_TEXT['not-https'] };
  }
}

/** The address looked up and checked public, or the sentence that says why not. The saved address is what is checked, never a path on it. */
export async function checkOwnSpeechEndpoint(endpoint: string): Promise<{ ok: true; checked: CheckedAddress } | { ok: false; reason: 'private' | 'unreachable' | 'bad-request'; message: string }> {
  try {
    return { ok: true, checked: await checkPublicHttpsUrl(endpoint) };
  } catch (error) {
    if (error instanceof AddressError) {
      return { ok: false, reason: error.problem === 'unresolved' ? 'unreachable' : error.problem === 'private' ? 'private' : 'bad-request', message: ADDRESS_PROBLEM_TEXT[error.problem] };
    }
    return { ok: false, reason: 'bad-request', message: 'That address can’t be used.' };
  }
}

/** The key as a header carries it: empty when the server has none. A character a header can't carry is refused, never sent. */
export function ownSpeechKey(raw: unknown): { ok: true; key: string } | { ok: false; message: string } {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key && !KEY_CHARACTERS.test(key)) return { ok: false, message: KEY_LOOKS_WRONG };
  return { ok: true, key };
}

/** The same checked addresses, for another path on the same name. */
const at = (checked: CheckedAddress, endpoint: string, path: string): CheckedAddress => ({ ...checked, url: new URL(`${endpoint}${path}`) });

type Listed = { ok: true; body: unknown } | { ok: false; reason: 'unreachable' | 'refused' | 'status' | 'unreadable'; status?: number };

/** One free GET of a list on the server. Nothing from an error is kept: it could carry the address with the key's header. */
async function getList(checked: CheckedAddress, endpoint: string, path: string, key: string): Promise<Listed> {
  const result = await safeGet(at(checked, endpoint, path), {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    timeoutMs: OWN_SPEECH_TIMEOUT_MS,
    maxBytes: LIST_MAX_BYTES,
  });
  if (!result.ok) return { ok: false, reason: result.reason === 'too-large' ? 'unreadable' : 'unreachable' };
  if (result.status === 401 || result.status === 403) return { ok: false, reason: 'refused' };
  if (result.status !== 200) return { ok: false, reason: 'status', status: result.status };
  try {
    return { ok: true, body: JSON.parse(result.body) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What a model says it does, in the words a server uses for a task. Anything else (no task, a chat or embedding task) is not
 * known, so the person picks. Never read from the model's name.
 */
const TASKS: Record<string, VoiceModel['kind']> = {
  'automatic-speech-recognition': 'recognition',
  'speech-recognition': 'recognition',
  transcription: 'recognition',
  'text-to-speech': 'speech',
  'speech-synthesis': 'speech',
  tts: 'speech',
};

export const taskKind = (task: unknown): VoiceModel['kind'] | null => (typeof task === 'string' ? (TASKS[task.trim().toLowerCase()] ?? null) : null);

export type OwnSpeechLoad =
  | {
      ok: true;
      /** The models whose job the server said. */
      models: VoiceModel[];
      /** The ids of models the server lists without saying what they do: the person picks for each. */
      unsure: string[];
      /** How many voices the server lists, or null when it has no voice list. */
      voices: number | null;
    }
  | { ok: false; reason: 'refused' | 'unreachable' | 'bad-request' | 'no-models'; message: string };

/** The voices a server lists at GET /audio/voices (Kokoro-FastAPI): `{ voices: [...] }` or a bare list, each a name or an object with an id. */
function readVoices(body: unknown): string[] | null {
  const list = Array.isArray(body) ? body : isRecord(body) ? body.voices : null;
  if (!Array.isArray(list)) return null;
  const ids: string[] = [];
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : isRecord(entry) ? (entry.voice_id ?? entry.id ?? entry.name) : null;
    if (typeof id !== 'string' || id.trim() === '' || id.length > 255) continue;
    if (!ids.includes(id.trim())) ids.push(id.trim());
    if (ids.length >= MAX_OWN_VOICES) break;
  }
  return ids;
}

/**
 * "Load models" for an own speech server: checks the address is public, asks the server for its model list with the key (when
 * there is one) and says what each model does. A server with no voice list answers `voices: null`. Nothing is saved, heard or spoken.
 */
export async function loadOwnSpeechServer(address: unknown, apiKey: unknown): Promise<OwnSpeechLoad> {
  const parsed = ownSpeechEndpoint(address);
  if (!parsed.ok) return { ok: false, reason: 'bad-request', message: parsed.message };
  const key = ownSpeechKey(apiKey);
  if (!key.ok) return { ok: false, reason: 'bad-request', message: key.message };
  const target = await checkOwnSpeechEndpoint(parsed.endpoint);
  if (!target.ok) return { ok: false, reason: target.reason === 'unreachable' ? 'unreachable' : 'bad-request', message: target.message };

  const list = await getList(target.checked, parsed.endpoint, '/models', key.key);
  if (!list.ok) {
    if (list.reason === 'refused') return { ok: false, reason: 'refused', message: WORDS.refused };
    if (list.reason === 'unreachable') return { ok: false, reason: 'unreachable', message: WORDS.unreachable };
    if (list.reason === 'unreadable') return { ok: false, reason: 'bad-request', message: WORDS.notSpeech };
    return { ok: false, reason: 'bad-request', message: `It answered with an error (${list.status}). Check the address.` };
  }
  const entries = Array.isArray(list.body) ? list.body : isRecord(list.body) ? list.body.data : null;
  if (!Array.isArray(entries)) return { ok: false, reason: 'bad-request', message: WORDS.notSpeech };

  const models: VoiceModel[] = [];
  const unsure: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > 255 || seen.has(id)) continue;
    if (seen.size >= MAX_OWN_MODELS) break;
    seen.add(id);
    const kind = taskKind((entry as Record<string, unknown>).task);
    if (kind) models.push({ id, kind });
    else unsure.push(id);
  }
  if (models.length === 0 && unsure.length === 0) return { ok: false, reason: 'no-models', message: WORDS.none };
  // Listening models first, as the voice companies are listed
  models.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'recognition' ? -1 : 1));

  // A server that speaks may list its voices. Free to read; a server without the list simply has none.
  let voices: number | null = null;
  if (unsure.length > 0 || models.some((model) => model.kind === 'speech')) {
    const answer = await getList(target.checked, parsed.endpoint, '/audio/voices', key.key);
    const found = answer.ok ? readVoices(answer.body) : null;
    voices = found && found.length > 0 ? found.length : null;
  }
  return { ok: true, models, unsure, voices };
}

/** The voices of a saved own server, for a bot's Voice row: its own list, or null when it has none. Cached by the caller. */
export async function listOwnSpeechVoices(endpoint: string, apiKey: string): Promise<{ voiceId: string }[] | null> {
  const target = await checkOwnSpeechEndpoint(endpoint);
  if (!target.ok) return null;
  const answer = await getList(target.checked, endpoint, '/audio/voices', apiKey);
  const found = answer.ok ? readVoices(answer.body) : null;
  return found && found.length > 0 ? found.map((voiceId) => ({ voiceId })) : null;
}
