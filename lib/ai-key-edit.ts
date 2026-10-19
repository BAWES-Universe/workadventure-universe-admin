import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { kindInfo } from '@/lib/ai-key-kinds';
import { cleanModelId, keyTarget, modelCaps, probeChat, probeModels, type ModelFactsById } from '@/lib/ai-key-models';
import { markWorking } from '@/lib/ai-key-health';

/**
 * Changing where a saved key points, or which model it uses (#374). The row stays the same row, so its lends and the
 * bots on it are untouched: a free cloudflared tunnel gets a new address every time it restarts, and revoking the key
 * to add it again would have lost them. Nothing is saved until the new address answers the model list with the saved
 * key, the model is on it, and one tiny chat reply from that model comes back.
 */
export interface KeyEditInput {
  address?: unknown;
  model?: unknown;
}

export type KeyEditResult =
  | { ok: true; model: string; endpoint: string }
  | { ok: false; status: 400 | 404 | 500; message: string; code?: 'model-missing' };

const KEY_SELECT = {
  providerId: true,
  name: true,
  ownerId: true,
  endpoint: true,
  apiKeyEncrypted: true,
  settings: true,
  model: true,
  downSince: true,
  ifDown: true,
  healthCheckedAt: true,
} as const;

/**
 * Only a key for a server on your own computer can be pointed at another address (a tunnel changes address on restart).
 * A hosted key, NVIDIA NIM included, stays with its provider: it is never sent to an address typed later, where it
 * could never be seen again to be checked.
 */
function canMoveAddress(info: { group: string }): boolean {
  return info.group === 'own-computer';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The address to try: the one typed, or the one saved. A hosted kind with a fixed address takes none. */
function addressToTry(typed: unknown, saved: string | null): string | undefined {
  return typeof typed === 'string' && typed.trim() ? typed : (saved ?? undefined);
}

async function loadOwnKey(ownerId: string, id: string) {
  return prisma.botsAiProvider.findFirst({ where: { providerId: id, ownerId }, select: KEY_SELECT });
}

type OwnKey = NonNullable<Awaited<ReturnType<typeof loadOwnKey>>>;

function savedApiKey(key: OwnKey): string | undefined {
  return key.apiKeyEncrypted ? decryptApiKey(key.apiKeyEncrypted) : undefined;
}

/** The models a saved key's provider lists, with the saved key, at the saved address or a new one the person is trying. */
export async function listModelsForSavedKey(
  ownerId: string,
  id: string,
  input: { address?: unknown },
): Promise<{ ok: true; models: string[]; facts: ModelFactsById } | { ok: false; status: 400 | 404 | 500; message: string }> {
  const key = await loadOwnKey(ownerId, id);
  if (!key) return { ok: false, status: 404, message: 'Key not found' };
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  if (!info) return { ok: false, status: 400, message: 'This key’s type is not known.' };
  if (typeof input.address === 'string' && input.address.trim() && !canMoveAddress(info)) {
    return { ok: false, status: 400, message: `${info.label} can’t be moved to another address.` };
  }
  const result = await probeModels({ kind: info.kind, address: addressToTry(input.address, key.endpoint), apiKey: savedApiKey(key) });
  return result.ok ? { ok: true, models: result.models, facts: result.facts } : { ok: false, status: 400, message: result.message };
}

export async function editSavedKey(ownerId: string, id: string, input: KeyEditInput): Promise<KeyEditResult> {
  const key = await loadOwnKey(ownerId, id);
  if (!key) return { ok: false, status: 404, message: 'Key not found' };
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  if (!info) return { ok: false, status: 400, message: 'This key’s type is not known.' };

  const typedAddress = typeof input.address === 'string' && input.address.trim() ? input.address : null;
  if (typedAddress && !canMoveAddress(info)) return { ok: false, status: 400, message: `${info.label} can’t be moved to another address.` };
  const typedModel = typeof input.model === 'string' ? input.model.trim() : null;
  if (typedModel !== null && (!typedModel || typedModel.length > 255)) return { ok: false, status: 400, message: 'Pick a model first.' };
  if (!typedAddress && typedModel === null) return { ok: false, status: 400, message: 'Nothing to change.' };

  const address = addressToTry(typedAddress, key.endpoint);
  const target = keyTarget({ kind: info.kind, address });
  if (!target.ok) return { ok: false, status: 400, message: target.message };
  const apiKey = savedApiKey(key);

  const models = await probeModels({ kind: info.kind, address, apiKey });
  if (!models.ok) return { ok: false, status: 400, message: models.message };
  const model = typedModel === null ? key.model : cleanModelId(typedModel, info.kind);
  if (!model) return { ok: false, status: 400, message: 'Pick a model first.' };
  // A model just picked must be on the list. The saved one may be an alias the list misses; the chat reply below decides.
  if (typedModel !== null && !models.models.includes(model)) {
    return { ok: false, status: 400, message: 'That model isn’t on the list. Load models again and pick one.' };
  }
  const chat = await probeChat({ kind: info.kind, address, apiKey, model });
  if (!chat.ok) {
    // The new address can't give the saved model (not on its list, or it says it has none): the person picks one it has
    // in the same step, instead of being stuck with a model that was only on the old address.
    const missing = typedAddress && typedModel === null && (chat.reason === 'gone' || (chat.reason === 'other' && !models.models.includes(model)));
    return { ok: false, status: 400, message: missing ? `That address doesn’t have ${model}. Pick a model it has.` : chat.message, ...(missing ? { code: 'model-missing' as const } : {}) };
  }

  // What the provider says about the model now in use. A saved model the list misses keeps what it had.
  const onList = models.models.includes(model);
  const caps = modelCaps(models.facts, model);
  const settings = { ...(isRecord(key.settings) ? key.settings : {}) };
  if (onList) {
    if (Object.keys(caps).length > 0) settings.caps = caps;
    else delete settings.caps;
  }

  // Same row, same id: lends and the bots running on it stay exactly as they are
  await prisma.botsAiProvider.updateMany({
    where: { providerId: id, ownerId },
    data: {
      endpoint: target.target.endpoint,
      model,
      tested: true,
      testedAt: new Date(),
      healthCheckedAt: new Date(),
      ...(onList ? { settings, supportsVision: caps.images ?? null } : {}),
    },
  });
  // It just answered a real chat call, so a key that was Down is Working again
  if (key.downSince) await markWorking({ providerId: key.providerId, ownerId });
  return { ok: true, model, endpoint: target.target.endpoint };
}
