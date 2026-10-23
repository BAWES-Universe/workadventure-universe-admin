import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { kindInfo } from '@/lib/ai-key-kinds';
import { probeModels, type ModelFacts, type ModelFactsById } from '@/lib/ai-key-models';

/**
 * Which models a person's key can run, and which of them a bot may use (#575). One key gives a bot any of its provider's
 * models: the bot keeps its own pick (`Bot.aiModel`), and a lend can allow only some of them (`AiKeyLend.models`, null =
 * all). The key's own `model` is now only its check model, which the health check asks for a tiny reply.
 *
 * The provider's list is asked with the saved key and kept here for a few minutes, so a bot page and a save in a row don't
 * call out twice. A provider with no model list (the model was typed when the key was added) has that one model. What the
 * provider says about each model (Tools, Vision, how much it reads) is kept on the key too (`settings.modelFacts`), so a bot's reply never
 * waits for the list to say whether its model sees images.
 */

export const MODEL_LIST_TTL_MS = 10 * 60_000;

export interface KeyForModels {
  providerId: string;
  endpoint: string | null;
  apiKeyEncrypted: string | null;
  settings: unknown;
  model: string | null;
}

/** `listed` is false for a provider with no model list: then the key's one model is all there is. */
export type KeyModelList = { ok: true; models: string[]; facts: ModelFactsById; listed: boolean } | { ok: false; message: string };

const cache = new Map<string, { at: number; list: Extract<KeyModelList, { ok: true }> }>();
const asking = new Map<string, Promise<KeyModelList>>();

/** The same key at the same address with the same check model; a moved address is asked again. */
const cacheKey = (key: KeyForModels) => `${key.providerId}|${key.endpoint ?? ''}|${key.model ?? ''}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Forgets every list kept for this key (its address or check model changed, or it was revoked). */
export function forgetKeyModels(providerId: string): void {
  for (const entry of cache.keys()) if (entry.startsWith(`${providerId}|`)) cache.delete(entry);
}

/**
 * The models this key's provider has now, from the list kept for a few minutes or asked for again (`fresh`: always asked).
 * Every caller's `key` then holds what the list said about each model, also one that joined a request already running.
 */
export async function keyModels(key: KeyForModels, options: { fresh?: boolean; now?: number } = {}): Promise<KeyModelList> {
  const list = await sharedModels(key, options);
  if (list.ok && list.listed) key.settings = { ...(isRecord(key.settings) ? key.settings : {}), modelFacts: slimFacts(list.facts), modelCount: list.models.length };
  return list;
}

async function sharedModels(key: KeyForModels, options: { fresh?: boolean; now?: number }): Promise<KeyModelList> {
  const id = cacheKey(key);
  const now = options.now ?? Date.now();
  const kept = cache.get(id);
  if (!options.fresh && kept && now - kept.at < MODEL_LIST_TTL_MS) return kept.list;
  const running = asking.get(id);
  if (running) return running;
  const asked = askProvider(key)
    .then(async (list) => {
      if (list.ok) {
        const at = Date.now();
        // Lists past their time are dropped as new ones come in, so keys nobody asks about any more don't stay in memory
        for (const [entry, value] of cache) if (at - value.at >= MODEL_LIST_TTL_MS) cache.delete(entry);
        cache.set(id, { at, list });
        if (list.listed) await rememberFacts(key, list.facts, list.models.length);
      }
      return list;
    })
    .finally(() => asking.delete(id));
  asking.set(id, asked);
  return asked;
}

async function askProvider(key: KeyForModels): Promise<KeyModelList> {
  const info = kindInfo(isRecord(key.settings) ? key.settings.kind : undefined);
  if (!info) return { ok: false, message: 'This key’s type is not known.' };
  let apiKey: string | undefined;
  try {
    apiKey = key.apiKeyEncrypted ? decryptApiKey(key.apiKeyEncrypted) : undefined;
  } catch {
    return { ok: false, message: 'The saved key can’t be read. Add it again.' };
  }
  // The saved endpoint already holds the region, the same as the health check asks it
  const result = await probeModels({ kind: info.kind, address: key.endpoint ?? undefined, apiKey });
  if (result.ok) return { ok: true, models: result.models, facts: result.facts, listed: true };
  if (result.noList) return { ok: true, models: key.model ? [key.model] : [], facts: {}, listed: false };
  return { ok: false, message: result.message };
}

/** The facts about one model that are well-formed (Tools, Vision, how much it reads); one the provider left out stays unknown. */
export function cleanFacts(fact: unknown): ModelFacts {
  if (!isRecord(fact)) return {};
  return {
    ...(typeof fact.tools === 'boolean' ? { tools: fact.tools } : {}),
    ...(typeof fact.vision === 'boolean' ? { vision: fact.vision } : {}),
    ...(typeof fact.context === 'number' && Number.isFinite(fact.context) && fact.context > 0 ? { context: fact.context } : {}),
  };
}

export function slimFacts(facts: ModelFactsById): Record<string, ModelFacts> {
  const slim: Record<string, ModelFacts> = {};
  for (const [model, fact] of Object.entries(facts)) {
    const kept = cleanFacts(fact);
    if (Object.keys(kept).length > 0) slim[model] = kept;
  }
  return slim;
}

/** Whether two saved values hold the same thing, whatever order their keys come in (Postgres reorders a jsonb's keys). */
function sameJson(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): string =>
    isRecord(value) ? `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${stable(value[name])}`).join(',')}}` : JSON.stringify(value);
  return stable(a) === stable(b);
}

/**
 * Saves what the provider says about each model on the key, and how many models it has (shown on the key card), only when
 * that changed. A failed save only costs a later guess.
 */
async function rememberFacts(key: KeyForModels, facts: ModelFactsById, modelCount: number): Promise<void> {
  const slim = slimFacts(facts);
  const saved = isRecord(key.settings) ? key.settings : {};
  if (sameJson(saved.modelFacts ?? {}, slim) && saved.modelCount === modelCount) return;
  try {
    // Read again just before writing, so a change made meanwhile (a new address, a new check model) is never undone
    const row = await prisma.botsAiProvider.findUnique({ where: { providerId: key.providerId }, select: { settings: true } });
    if (!row) return;
    const settings = { ...(isRecord(row.settings) ? row.settings : {}), modelFacts: slim, modelCount };
    await prisma.botsAiProvider.updateMany({ where: { providerId: key.providerId, ownerId: { not: null } }, data: { settings } });
    key.settings = settings;
  } catch (error) {
    console.error('[AiKeys] Could not keep the model facts:', error instanceof Error ? error.message : 'unknown');
  }
}

/** What is known about one of a key's models: what the provider said when it was listed, else what its docs say. */
export function modelFactsOf(key: { settings: unknown; model: string | null; supportsVision?: boolean | null }, model: string): ModelFacts {
  const settings = isRecord(key.settings) ? key.settings : {};
  const listed = isRecord(settings.modelFacts) && isRecord(settings.modelFacts[model]) ? (settings.modelFacts[model] as Record<string, unknown>) : null;
  const known = kindInfo(settings.kind)?.knownFacts?.[model];
  return cleanFacts(listed ?? known ?? (model === key.model && isRecord(settings.caps) ? settings.caps : null));
}

/** Whether a bot on this model sees images: the provider's word (null when it said nothing, left to the bot server's guess). */
export function modelSupportsVision(key: { settings: unknown; model: string | null; supportsVision: boolean | null }, model: string): boolean | null {
  // The check model keeps what was saved with the key, exactly as before
  if (model === key.model) return key.supportsVision;
  return modelFactsOf(key, model).vision ?? null;
}

/** A lend's model list as saved: model ids, or null for all of them. */
export function lendModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const models = raw.filter((model): model is string => typeof model === 'string' && model !== '');
  return models.length > 0 ? models : null;
}

/** The key's models a lend allows, in the provider's order. */
export function allowedModels(list: string[], lend: string[] | null): string[] {
  return lend ? list.filter((model) => lend.includes(model)) : list;
}

/** The model a bot on this key replies with: its own pick, else the key's check model, kept to what the lend allows. */
export function servedModel(bot: { aiModel: string | null }, key: { model: string | null }, lend: string[] | null): string | null {
  const model = bot.aiModel ?? key.model;
  if (!lend || (model && lend.includes(model))) return model;
  return lend[0];
}
