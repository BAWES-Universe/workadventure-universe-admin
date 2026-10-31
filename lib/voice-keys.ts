import { Prisma, type VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';
import { lendAccess, parseLendModels } from '@/lib/ai-key-lend';
import { readModels, voiceProviderProblem, type VoiceModel } from '@/lib/voice-providers';
import { healthOf, askForVoiceKeyTry, type VoiceKeyHealth } from '@/lib/voice-key-health';

/**
 * Personal voice keys (#749). A key is a VoiceProvider row with an `ownerId`; the rows with none are the server's own
 * providers (lib/voice-providers.ts), which these functions never touch. A person adds a key, lends it to a universe where
 * they have Manage bots, and bots they made there may then listen or speak with it, paid by the key's owner. Lending moves no
 * bot. Nothing here calls a provider: the models a key lists are the ones its owner names.
 */

/** A speech company a person can add a key for, and what it can do. */
export interface VoiceKeyCompany {
  adapter: string;
  label: string;
  recognition: boolean;
  speech: boolean;
}

/**
 * The speech companies a person can add a key for: the adapters of the server's own providers that are on (lib/voice-providers.ts),
 * so a super admin decides what Universe supports and a company with no adapter behind it can't be added. One entry per
 * adapter, named as the first of its providers is, doing whatever any of them does.
 */
export async function voiceKeyCompanies(): Promise<VoiceKeyCompany[]> {
  const rows = await prisma.voiceProvider.findMany({
    where: { enabled: true, ownerId: null },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { adapter: true, name: true, recognition: true, speech: true },
  });
  const companies = new Map<string, VoiceKeyCompany>();
  for (const row of rows) {
    const known = companies.get(row.adapter);
    if (known) {
      known.recognition ||= row.recognition;
      known.speech ||= row.speech;
    } else {
      companies.set(row.adapter, { adapter: row.adapter, label: row.name, recognition: row.recognition, speech: row.speech });
    }
  }
  return [...companies.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const modelSchema = z.object({
  id: z.string().trim().min(1, 'A model needs an id').max(255),
  label: z.string().trim().max(255).optional(),
  kind: z.enum(['recognition', 'speech']),
});
const fields = {
  name: z.string().trim().min(1, 'name is required').max(255),
  apiKey: z.string().trim().min(8, 'apiKey looks too short').max(2000),
  models: z.array(modelSchema).max(200, 'A key can list up to 200 models'),
};

export const createVoiceKeySchema = z
  .object({
    adapter: z.string().trim().min(1, 'Pick a speech company from the list').max(50),
    name: fields.name.optional(),
    recognition: z.boolean().default(false),
    speech: z.boolean().default(false),
    apiKey: fields.apiKey,
    models: fields.models.default([]),
  })
  .strict();

export const updateVoiceKeySchema = z.object({ name: fields.name, apiKey: fields.apiKey, models: fields.models }).partial().strict();

/** A key that can't be saved or lent as asked, with the line that says why (shown as it is). */
export class VoiceKeyRefused extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

/** A model as a lend names it: its job and its id, so a listening and a speaking model with one id are told apart. */
export const lendModelId = (model: Pick<VoiceModel, 'kind' | 'id'>) => `${model.kind}:${model.id}`;

/** The models a lend allows: null for all of the key's, else the ids that are well formed. */
export function readLendModels(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;
}

/** What the owner sees of one key. Never the key itself, encrypted or not. */
export interface VoiceKeySummary {
  id: string;
  adapter: string;
  company: string;
  name: string;
  recognition: boolean;
  speech: boolean;
  /** The last four characters of the key. */
  last4: string | null;
  models: VoiceModel[];
  /** The universes it is lent to, and which of its models bots there may use ("kind:id", null for all of them). */
  lentTo: { universeId: string; universeName: string; ownedByYou: boolean; models: string[] | null }[];
  createdAt: string;
  /** Whether the key works: Down once its provider turned it away (out of credit, rejected, repeated errors). Bots on it reply in text meanwhile. */
  health: VoiceKeyHealth;
}

type KeyRow = VoiceProvider & { lends: { models: Prisma.JsonValue; universe: { id: string; name: string; ownerId: string } }[] };

const summary = (row: KeyRow, ownerId: string, labels: Map<string, string>): VoiceKeySummary => ({
  id: row.id,
  adapter: row.adapter,
  company: labels.get(row.adapter) ?? row.adapter,
  name: row.name,
  recognition: row.recognition,
  speech: row.speech,
  last4: row.apiKeyLast4,
  models: readModels(row.models),
  lentTo: row.lends.map((lend) => ({
    universeId: lend.universe.id,
    universeName: lend.universe.name,
    ownedByYou: lend.universe.ownerId === ownerId,
    models: readLendModels(lend.models),
  })),
  createdAt: row.createdAt.toISOString(),
  health: healthOf(row),
});

/** How each company is named: the server's own providers' names, else the adapter as it is. */
const labelsOf = async () => new Map((await voiceKeyCompanies()).map((company) => [company.adapter, company.label]));

const include = { lends: { orderBy: { lentAt: 'asc' as const }, select: { models: true, universe: { select: { id: true, name: true, ownerId: true } } } } };

/** The caller's own voice keys, oldest first. */
export async function listVoiceKeys(ownerId: string): Promise<VoiceKeySummary[]> {
  const rows = await prisma.voiceProvider.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' }, include });
  const labels = await labelsOf();
  return rows.map((row) => summary(row, ownerId, labels));
}

const owned = (id: string, ownerId: string) => prisma.voiceProvider.findFirst({ where: { id, ownerId }, include });

/** The problem a key's job and models have, or null: a key listens, speaks or both, and lists models only for what it does. */
const problem = (draft: { recognition: boolean; speech: boolean; models: VoiceModel[] }) =>
  voiceProviderProblem({ ...draft, enabled: true, defaultRecognition: false, defaultSpeech: false, hasKey: true });

export async function createVoiceKey(ownerId: string, input: z.infer<typeof createVoiceKeySchema>): Promise<VoiceKeySummary> {
  const refused = problem(input);
  if (refused) throw new VoiceKeyRefused(refused);
  const company = (await voiceKeyCompanies()).find((entry) => entry.adapter === input.adapter);
  if (!company) throw new VoiceKeyRefused('Pick a speech company from the list');
  if ((input.recognition && !company.recognition) || (input.speech && !company.speech)) {
    throw new VoiceKeyRefused(`${company.label} doesn’t do ${input.recognition && !company.recognition ? 'listening' : 'speaking'}`);
  }
  const row = await prisma.voiceProvider.create({
    data: {
      adapter: input.adapter,
      name: input.name ?? company.label,
      recognition: input.recognition,
      speech: input.speech,
      // A person's own key is on from the start: it only reaches bots they made, in universes they lend it to
      enabled: true,
      apiKeyEncrypted: encryptApiKey(input.apiKey),
      apiKeyLast4: input.apiKey.slice(-4),
      models: input.models as Prisma.InputJsonValue,
      ownerId,
      createdById: ownerId,
    },
    include,
  });
  return summary(row, ownerId, await labelsOf());
}

/** Changes only what is named. A model taken off the key is taken off every lend that named it; a lend left with none is pulled. */
export async function updateVoiceKey(ownerId: string, id: string, input: z.infer<typeof updateVoiceKeySchema>): Promise<VoiceKeySummary> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.voiceProvider.findFirst({ where: { id, ownerId } });
    if (!row) throw new VoiceKeyRefused('Key not found', 404);
    const models = input.models ?? readModels(row.models);
    const refused = problem({ recognition: row.recognition, speech: row.speech, models });
    if (refused) throw new VoiceKeyRefused(refused);
    await tx.voiceProvider.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        // A new key starts clean: it is tried at once, not after the old one's wait
        ...(input.apiKey !== undefined
          ? { apiKeyEncrypted: encryptApiKey(input.apiKey), apiKeyLast4: input.apiKey.slice(-4), downSince: null, downReason: null, downPart: null, failedRecognition: 0, failedSpeech: 0, healthCheckedAt: null }
          : {}),
        ...(input.models !== undefined ? { models: input.models as Prisma.InputJsonValue } : {}),
      },
    });
    if (input.models !== undefined) {
      const kept = new Set(models.map(lendModelId));
      const lends = await tx.voiceKeyLend.findMany({ where: { providerId: id, models: { not: Prisma.DbNull } }, select: { id: true, models: true } });
      for (const lend of lends) {
        const allowed = readLendModels(lend.models);
        if (!allowed) continue;
        const left = allowed.filter((entry) => kept.has(entry));
        if (left.length === allowed.length) continue;
        // A lend that named only models the key no longer lists would allow nothing: it is pulled from that universe, as if
        // the owner had pulled the key (its bots carry on in text), never widened to all of the key's models
        if (left.length === 0) await tx.voiceKeyLend.delete({ where: { id: lend.id } });
        else await tx.voiceKeyLend.update({ where: { id: lend.id }, data: { models: left } });
      }
    }
  });
  const row = await owned(id, ownerId);
  if (!row) throw new VoiceKeyRefused('Key not found', 404);
  return summary(row, ownerId, await labelsOf());
}

/** Takes the key away, and with it every lend. Bots whose voice named it carry on in text (their voice no longer works). */
export async function deleteVoiceKey(ownerId: string, id: string): Promise<void> {
  const removed = await prisma.voiceProvider.deleteMany({ where: { id, ownerId } });
  if (removed.count === 0) throw new VoiceKeyRefused('Key not found', 404);
}

/**
 * Lends the key to a universe where the caller owns it or has Manage bots. `models` (undefined = as it is, all for a new lend;
 * null = all; a list of "kind:id") says which of the key's models bots there may use. Lending again changes nothing but the list.
 */
export async function lendVoiceKey(ownerId: string, id: string, universeId: string, rawModels: unknown): Promise<VoiceKeySummary> {
  const parsed = parseLendModels(rawModels);
  if (!parsed.ok) throw new VoiceKeyRefused(parsed.message);
  const key = await owned(id, ownerId);
  if (!key) throw new VoiceKeyRefused('Key not found', 404);
  if (!(await lendAccess(ownerId, universeId))) throw new VoiceKeyRefused('You need Manage bots in that universe to lend a key to it.', 403);
  let models = parsed.models;
  if (models) {
    const listed = new Set(readModels(key.models).map(lendModelId));
    const missing = models.find((model) => !listed.has(model));
    if (missing) throw new VoiceKeyRefused(`${missing} isn’t on this key’s list. Pick from the models it lists.`);
    // Kept in the key's own order
    models = readModels(key.models).map(lendModelId).filter((entry) => models!.includes(entry));
  }
  const where = { providerId_universeId: { providerId: id, universeId } };
  const update = models === undefined ? {} : { models: models ?? Prisma.DbNull };
  try {
    await prisma.voiceKeyLend.upsert({ where, create: { providerId: id, universeId, ...(models ? { models } : {}) }, update });
  } catch (error) {
    // The key was deleted, or the universe, between the checks above and the save
    if ((error as { code?: unknown })?.code === 'P2003') throw new VoiceKeyRefused('Key or universe not found', 404);
    throw error;
  }
  const row = await owned(id, ownerId);
  if (!row) throw new VoiceKeyRefused('Key not found', 404);
  return summary(row, ownerId, await labelsOf());
}

/** Pulls the key from a universe. Always the key owner's to do, whatever they can manage there now. */
export async function pullVoiceKey(ownerId: string, id: string, universeId: string): Promise<void> {
  const removed = await prisma.voiceKeyLend.deleteMany({ where: { providerId: id, universeId, provider: { ownerId } } });
  if (removed.count === 0) throw new VoiceKeyRefused('Not lent to that universe', 404);
}

/**
 * "Check now" on a Down key: the next bot that needs it is let through to try, without waiting out the 5 minutes. Orbit calls no
 * provider; the key goes back to Working when that try works. A key that isn't Down has nothing to check.
 */
export async function checkVoiceKey(ownerId: string, id: string): Promise<VoiceKeySummary> {
  const row = await owned(id, ownerId);
  if (!row) throw new VoiceKeyRefused('Key not found', 404);
  if (row.downSince) await askForVoiceKeyTry(ownerId, id);
  const fresh = await owned(id, ownerId);
  if (!fresh) throw new VoiceKeyRefused('Key not found', 404);
  return summary(fresh, ownerId, await labelsOf());
}
