import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { kindInfo } from '@/lib/ai-key-kinds';
import { cleanModelId, keyTarget, modelCaps, probeChat, probeModels, type ModelFactsById } from '@/lib/ai-key-models';
import { markWorking } from '@/lib/ai-key-health';
import { forgetKeyModels, keyModels, lendModels, slimFacts } from '@/lib/ai-key-model-list';

/**
 * Changing where a saved key points, or which model it uses (#374). The row stays the same row, so its lends and the
 * bots on it stay (a bot still on the old model moves to the new one with it): a free cloudflared tunnel gets a new address every time it restarts, and revoking the key
 * to add it again would have lost them. Nothing is saved until the new address answers the model list with the saved
 * key, the model is on it, and one tiny chat reply from that model comes back.
 */
export interface KeyEditInput {
  address?: unknown;
  model?: unknown;
}

export type KeyEditResult =
  | { ok: true; model: string; endpoint: string }
  | { ok: false; status: 400 | 404 | 409 | 500; message: string; code?: 'model-missing' };

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
): Promise<{ ok: true; models: string[]; facts: ModelFactsById } | { ok: false; status: 400 | 404 | 500; message: string; noList?: true }> {
  const key = await loadOwnKey(ownerId, id);
  if (!key) return { ok: false, status: 404, message: 'Key not found' };
  const info = kindInfo((key.settings as { kind?: unknown } | null)?.kind);
  if (!info) return { ok: false, status: 400, message: 'This key’s type is not known.' };
  if (typeof input.address === 'string' && input.address.trim() && !canMoveAddress(info)) {
    return { ok: false, status: 400, message: `${info.label} can’t be moved to another address.` };
  }
  // At the saved address the key's list is asked again and kept, which also keeps its model facts and count up to date (#575)
  if (!(typeof input.address === 'string' && input.address.trim())) {
    const kept = await keyModels(key, { fresh: true });
    if (!kept.ok) return { ok: false, status: 400, message: kept.message };
    if (!kept.listed) return { ok: false, status: 400, message: `${info.label} doesn’t share a list of its models. Type the model name.`, noList: true };
    return { ok: true, models: kept.models, facts: kept.facts };
  }
  const result = await probeModels({ kind: info.kind, address: addressToTry(input.address, key.endpoint), apiKey: savedApiKey(key) });
  return result.ok ? { ok: true, models: result.models, facts: result.facts } : { ok: false, status: 400, message: result.message, ...(result.noList ? { noList: true as const } : {}) };
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

  const probed = await probeModels({ kind: info.kind, address, apiKey });
  if (!probed.ok && !probed.noList) return { ok: false, status: 400, message: probed.message };
  // A provider with no model list: nothing is on a list, so the chat reply below is the only check
  const models = probed.ok ? probed : { models: [] as string[], facts: {} as ModelFactsById };
  const model = typedModel === null ? key.model : cleanModelId(typedModel, info.kind);
  if (!model) return { ok: false, status: 400, message: 'Pick a model first.' };
  // A model just picked must be on the list. The saved one may be an alias the list misses; the chat reply below decides.
  if (probed.ok && typedModel !== null && !models.models.includes(model)) {
    return { ok: false, status: 400, message: 'That model isn’t on the list. Load models again and pick one.' };
  }
  const chat = await probeChat({ kind: info.kind, address, apiKey, model, ...(probed.ok ? {} : { noList: true }) });
  if (!chat.ok) {
    // The new address can't give the saved model (not on its list, or it says it has none): the person picks one it has
    // in the same step, instead of being stuck with a model that was only on the old address.
    const missing = typedAddress && typedModel === null && (chat.reason === 'gone' || ((chat.reason === 'other' || chat.reason === 'request') && !models.models.includes(model)));
    // The model is there and the provider only refused this tiny request (a reasoning model that wants a bigger cap, say):
    // nothing is wrong with the key or the model, so the change is saved, the same as the health check lets it pass
    // A model with no list behind it (the provider has none) is saved only on a real reply
    if (chat.reason !== 'request' || missing || !probed.ok) {
      return { ok: false, status: 400, message: missing ? `That address doesn’t have ${model}. Pick a model it has.` : chat.message, ...(missing ? { code: 'model-missing' as const } : {}) };
    }
  }

  // What the provider says about the model now in use. A saved model the list misses keeps what it had.
  const onList = models.models.includes(model);
  const caps = modelCaps(models.facts, model);
  const settings = { ...(isRecord(key.settings) ? key.settings : {}) };
  if (onList) {
    if (Object.keys(caps).length > 0) settings.caps = caps;
    else delete settings.caps;
  }
  // The list just read is this address's: the card's model count and each model's facts are its own, not the old address's
  if (probed.ok) {
    settings.modelFacts = slimFacts(models.facts);
    settings.modelCount = models.models.length;
  }

  // Same row, same id: lends and the bots running on it stay. The checks took a while: when only the address changed, a
  // check model swapped meanwhile (the old one went, #575) is never put back.
  // Bots on the key were given its model when each bot got a model of its own (#575), so a bot still on the old model moves
  // to the new one in the same save, as Change model always did; a bot given another model on purpose keeps it, and so does
  // a bot in a universe whose lend doesn't allow the new model.
  const movesBots = typedModel !== null && key.model !== null && model !== key.model;
  const count = await prisma.$transaction(async (tx) => {
    // Another Change model may have saved while this one was checked: bots it moved are on its model, so they move too. The
    // row is locked first, so a save at the same moment waits for this one and then reads the model it saved.
    if (movesBots) await tx.$queryRaw`SELECT 1 FROM "bots_ai_providers" WHERE "provider_id" = ${id} AND "owner_id" = ${ownerId} FOR UPDATE`;
    const before = movesBots ? await tx.botsAiProvider.findFirst({ where: { providerId: id, ownerId }, select: { model: true } }) : null;
    const saved = await tx.botsAiProvider.updateMany({
      where: { providerId: id, ownerId, ...(typedModel === null ? { model: key.model } : {}) },
      data: {
        endpoint: target.target.endpoint,
        model,
        tested: true,
        testedAt: new Date(),
        healthCheckedAt: new Date(),
        ...(probed.ok ? { settings } : {}),
        ...(onList ? { supportsVision: caps.vision ?? null } : {}),
      },
    });
    const from = [...new Set([key.model, before?.model])].filter((old): old is string => !!old && old !== model);
    if (saved.count > 0 && from.length > 0) {
      const lends = await tx.aiKeyLend.findMany({ where: { providerId: id }, select: { universeId: true, models: true } });
      const closed = lends.filter((lend) => !(lendModels(lend.models)?.includes(model) ?? true)).map((lend) => lend.universeId);
      await tx.bot.updateMany({
        where: { aiProviderRef: id, aiModel: { in: from }, ...(closed.length > 0 ? { NOT: { room: { world: { universeId: { in: closed } } } } } : {}) },
        data: { aiModel: model },
      });
    }
    return saved.count;
  });
  if (count === 0) return { ok: false, status: 409, message: 'This key changed while it was checked. Open Edit again.' };
  // A new address can list other models: the list kept for the old one is asked again next time
  forgetKeyModels(id);
  // It just answered a real chat call, so a key that was Down is Working again
  if (key.downSince) await markWorking({ providerId: key.providerId, ownerId });
  return { ok: true, model, endpoint: target.target.endpoint };
}
