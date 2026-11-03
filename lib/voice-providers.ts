import type { Prisma, VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';

/**
 * Voice providers (#740): the speech companies a super admin sets up for the whole server. Each can listen (recognition),
 * speak (speech) or both, and has the models it can be used with. Which adapter runs one is the bot server's business: Orbit
 * keeps what to call it, where to reach it and with which key. The key is encrypted, never sent to a browser, and never
 * tested here (nothing paid is called from Orbit).
 *
 * At most one provider is the default for listening and one for speaking. A bot on Universe AI follows them.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,48}$/;

const modelSchema = z.object({
  id: z.string().trim().min(1, 'A model needs an id').max(255),
  label: z.string().trim().max(255).optional(),
  kind: z.enum(['recognition', 'speech']),
});

export type VoiceModel = z.infer<typeof modelSchema>;

const fields = {
  adapter: z.string().trim().regex(NAME, 'adapter must be lowercase letters, numbers and dashes'),
  name: z.string().trim().min(1, 'name is required').max(255),
  recognition: z.boolean(),
  speech: z.boolean(),
  enabled: z.boolean(),
  // https:// for every company; wss:// too, for one that only listens (Soniox and Deepgram listen on a websocket address)
  endpoint: z
    .string()
    .trim()
    .url('endpoint must be a web address')
    .refine((value) => /^(https|wss):\/\//i.test(value), 'endpoint must start with https:// (or wss:// for a provider that only listens)')
    .max(2000)
    .nullable(),
  region: z.string().trim().min(1).max(50).nullable(),
  // A new key replaces the saved one; null takes it away
  apiKey: z.string().trim().min(8, 'apiKey looks too short').max(2000).nullable(),
  models: z.array(modelSchema).max(200, 'A provider can list up to 200 models'),
  defaultRecognition: z.boolean(),
  defaultSpeech: z.boolean(),
  // The voice Universe AI speaks with when this is the default speaking provider (game #1668); null takes it away
  defaultVoiceId: z.string().trim().min(1, 'defaultVoiceId can’t be empty').max(255).nullable(),
  defaultVoiceName: z.string().trim().min(1, 'defaultVoiceName can’t be empty').max(255).nullable(),
};

export const createVoiceProviderSchema = z
  .object({ adapter: fields.adapter, name: fields.name, recognition: fields.recognition.default(false), speech: fields.speech.default(false) })
  .extend({
    enabled: fields.enabled.default(false),
    endpoint: fields.endpoint.optional(),
    region: fields.region.optional(),
    apiKey: fields.apiKey.optional(),
    models: fields.models.default([]),
  })
  .strict();

export const updateVoiceProviderSchema = z
  .object({
    adapter: fields.adapter,
    name: fields.name,
    recognition: fields.recognition,
    speech: fields.speech,
    enabled: fields.enabled,
    endpoint: fields.endpoint,
    region: fields.region,
    apiKey: fields.apiKey,
    models: fields.models,
    defaultRecognition: fields.defaultRecognition,
    defaultSpeech: fields.defaultSpeech,
    defaultVoiceId: fields.defaultVoiceId,
    defaultVoiceName: fields.defaultVoiceName,
  })
  .partial()
  .strict();

/** A provider that can't be saved as asked, with the line that says why (shown as it is). */
export class VoiceProviderRefused extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

/** What a super admin sees of a provider: everything but the key. */
export function voiceProviderView(row: VoiceProvider) {
  return {
    id: row.id,
    adapter: row.adapter,
    name: row.name,
    recognition: row.recognition,
    speech: row.speech,
    enabled: row.enabled,
    endpoint: row.endpoint,
    region: row.region,
    hasKey: Boolean(row.apiKeyEncrypted),
    apiKeyLast4: row.apiKeyLast4,
    models: readModels(row.models),
    defaultRecognition: row.defaultRecognition,
    defaultSpeech: row.defaultSpeech,
    defaultVoiceId: row.defaultVoiceId,
    defaultVoiceName: row.defaultVoiceName,
    updatedAt: row.updatedAt,
  };
}

export function readModels(value: unknown): VoiceModel[] {
  const parsed = z.array(modelSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

type Draft = Pick<VoiceProvider, 'recognition' | 'speech' | 'enabled' | 'defaultRecognition' | 'defaultSpeech'> & {
  models: VoiceModel[];
  hasKey: boolean;
  endpoint?: string | null;
  defaultVoiceId?: string | null;
  defaultVoiceName?: string | null;
};

/** Why a provider can't be saved like this, or null. A default must be enabled, hold its key and do its job. */
export function voiceProviderProblem(draft: Draft): string | null {
  if (!draft.recognition && !draft.speech) return 'A provider must listen, speak, or both';
  if (draft.models.some((model) => !draft[model.kind])) return 'A model can only be listed for what the provider does';
  if (draft.defaultVoiceId && !draft.speech) return 'Only a provider that speaks can have a default voice';
  if (draft.defaultVoiceName && !draft.defaultVoiceId) return 'A default voice name needs the default voice';
  // A speaking call and the list of voices go to the address over https, so a websocket address is for a provider that only listens
  if (draft.endpoint && /^wss:\/\//i.test(draft.endpoint) && draft.speech) return 'A provider that speaks needs an https:// address';
  const ids = draft.models.map((model) => `${model.kind}:${model.id}`);
  if (new Set(ids).size !== ids.length) return 'A model is listed twice';
  for (const [isDefault, can, job] of [
    [draft.defaultRecognition, draft.recognition, 'listening'],
    [draft.defaultSpeech, draft.speech, 'speaking'],
  ] as const) {
    if (!isDefault) continue;
    if (!can) return `Only a provider that does ${job} can be the default for it`;
    if (!draft.enabled) return `The default for ${job} must be on`;
    if (!draft.hasKey) return `The default for ${job} needs its key`;
  }
  return null;
}

/** The server's own providers only: a key a person added (#749) is theirs, never a super admin's to list, change or default. */
export const listVoiceProviders = () => prisma.voiceProvider.findMany({ where: { ownerId: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });

export async function createVoiceProvider(input: z.infer<typeof createVoiceProviderSchema>, userId: string): Promise<VoiceProvider> {
  const problem = voiceProviderProblem({ ...input, endpoint: input.endpoint ?? null, defaultRecognition: false, defaultSpeech: false, hasKey: Boolean(input.apiKey) });
  if (problem) throw new VoiceProviderRefused(problem);
  return prisma.voiceProvider.create({
    data: {
      adapter: input.adapter,
      name: input.name,
      recognition: input.recognition,
      speech: input.speech,
      enabled: input.enabled,
      endpoint: input.endpoint ?? null,
      region: input.region ?? null,
      ...(input.apiKey ? { apiKeyEncrypted: encryptApiKey(input.apiKey), apiKeyLast4: input.apiKey.slice(-4) } : {}),
      models: input.models as Prisma.InputJsonValue,
      createdById: userId,
    },
  });
}

/** Changes only what is named. Making one the default takes it from the one that had it, in one transaction. */
export async function updateVoiceProvider(id: string, input: z.infer<typeof updateVoiceProviderSchema>): Promise<VoiceProvider> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.voiceProvider.findUnique({ where: { id } });
    if (!row || row.ownerId !== null) throw new VoiceProviderRefused('Voice provider not found', 404);
    const changesCompany = input.adapter !== undefined && input.adapter !== row.adapter;
    const next = {
      recognition: input.recognition ?? row.recognition,
      speech: input.speech ?? row.speech,
      enabled: input.enabled ?? row.enabled,
      defaultRecognition: input.defaultRecognition ?? row.defaultRecognition,
      defaultSpeech: input.defaultSpeech ?? row.defaultSpeech,
      models: input.models ?? readModels(row.models),
      endpoint: input.endpoint === undefined ? row.endpoint : input.endpoint,
      // The name goes with its voice: a new voice id without a name drops the old name, and no voice has no name
      // A voice belongs to its company: a provider moved to another adapter loses it unless a new one comes with the change
      defaultVoiceId: input.defaultVoiceId === undefined ? (changesCompany ? null : row.defaultVoiceId) : input.defaultVoiceId,
      defaultVoiceName:
        input.defaultVoiceName !== undefined
          ? input.defaultVoiceName
          : (input.defaultVoiceId !== undefined && input.defaultVoiceId !== row.defaultVoiceId) || (input.defaultVoiceId === undefined && changesCompany)
            ? null
            : row.defaultVoiceName,
      hasKey: input.apiKey === undefined ? Boolean(row.apiKeyEncrypted) : input.apiKey !== null,
    };
    const problem = voiceProviderProblem(next);
    if (problem) throw new VoiceProviderRefused(problem, row.defaultRecognition || row.defaultSpeech ? 409 : 400);
    if (next.defaultRecognition && !row.defaultRecognition) await tx.voiceProvider.updateMany({ where: { defaultRecognition: true }, data: { defaultRecognition: false } });
    if (next.defaultSpeech && !row.defaultSpeech) await tx.voiceProvider.updateMany({ where: { defaultSpeech: true }, data: { defaultSpeech: false } });
    return tx.voiceProvider.update({
      where: { id },
      data: {
        ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.apiKey === undefined ? {} : input.apiKey === null ? { apiKeyEncrypted: null, apiKeyLast4: null } : { apiKeyEncrypted: encryptApiKey(input.apiKey), apiKeyLast4: input.apiKey.slice(-4) }),
        ...(input.models !== undefined ? { models: input.models as Prisma.InputJsonValue } : {}),
        recognition: next.recognition,
        speech: next.speech,
        enabled: next.enabled,
        defaultRecognition: next.defaultRecognition,
        defaultSpeech: next.defaultSpeech,
        ...(input.defaultVoiceId !== undefined || input.defaultVoiceName !== undefined || (changesCompany && row.defaultVoiceId)
          ? { defaultVoiceId: next.defaultVoiceId, defaultVoiceName: next.defaultVoiceId ? next.defaultVoiceName : null }
          : {}),
      },
    });
  });
}

/**
 * How many bots use each server provider, for the Universe AI page: a bot counts for a job when it has voice on and the profile it
 * speaks with names the provider for that job. Bots on a person's own key are not counted here.
 */
export async function voiceProviderBotCounts(): Promise<Map<string, { recognition: number; speech: number }>> {
  const rows = await prisma.$queryRaw<{ profile: unknown }[]>`
    SELECT r.profile AS profile
    FROM bots b
    JOIN bot_voice_revisions r ON r.bot_id = b.id AND r.number = b.voice_revision
    WHERE b.voice_enabled = true`;
  const counts = new Map<string, { recognition: number; speech: number }>();
  const add = (id: unknown, job: 'recognition' | 'speech') => {
    if (typeof id !== 'string') return;
    const entry = counts.get(id) ?? { recognition: 0, speech: 0 };
    entry[job] += 1;
    counts.set(id, entry);
  };
  for (const { profile } of rows) {
    const saved = typeof profile === 'object' && profile !== null ? (profile as { recognition?: { providerId?: unknown }; speech?: { providerId?: unknown } }) : {};
    add(saved.recognition?.providerId, 'recognition');
    add(saved.speech?.providerId, 'speech');
  }
  return counts;
}

/** A default can't be deleted: another is made the default first. */
export async function deleteVoiceProvider(id: string): Promise<void> {
  const row = await prisma.voiceProvider.findUnique({ where: { id } });
  if (!row || row.ownerId !== null) throw new VoiceProviderRefused('Voice provider not found', 404);
  if (row.defaultRecognition || row.defaultSpeech) throw new VoiceProviderRefused('Make another provider the default for what this one does first', 409);
  await prisma.voiceProvider.delete({ where: { id } });
}

/** What the bot server reads: the providers that are on, without their keys, and which are the defaults. */
export async function servedVoiceProviders() {
  const rows = await prisma.voiceProvider.findMany({ where: { enabled: true, ownerId: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  const view = (row: VoiceProvider) => {
    const { id, adapter, name, recognition, speech, endpoint, region, models } = voiceProviderView(row);
    return { id, adapter, name, recognition, speech, endpoint, region, models, hasKey: Boolean(row.apiKeyEncrypted) };
  };
  return {
    providers: rows.map(view),
    defaults: {
      recognition: rows.find((row) => row.defaultRecognition)?.id ?? null,
      speech: rows.find((row) => row.defaultSpeech)?.id ?? null,
    },
  };
}

/**
 * Universe AI as the bot page needs it (game #1668): for listening and for speaking, the server's default provider with the model
 * to start from (the first one it lists for that job) and, for speaking, the voice a super admin set as the default (null when
 * none was set: the page then takes the first voice the provider lists). A job is null when the server has no usable default for
 * it, which the page reads as "Universe AI's voice is off" / "not on this server yet". Never the key.
 */
export async function universeAiDefaults() {
  const rows = await prisma.voiceProvider.findMany({ where: { enabled: true, ownerId: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  const part = (kind: 'recognition' | 'speech') => {
    const row = rows.find((candidate) => (kind === 'recognition' ? candidate.defaultRecognition : candidate.defaultSpeech));
    if (!row || !row.apiKeyEncrypted) return null;
    const models = readModels(row.models).filter((model) => model.kind === kind);
    if (models.length === 0) return null;
    return {
      providerId: row.id,
      adapter: row.adapter,
      name: row.name,
      model: models[0].id,
      models: models.map((model) => ({ id: model.id, label: model.label ?? null })),
    };
  };
  const speech = part('speech');
  const speechRow = speech ? rows.find((row) => row.id === speech.providerId) : undefined;
  return {
    recognition: part('recognition'),
    speech: speech && {
      ...speech,
      defaultVoice: speechRow?.defaultVoiceId ? { voiceId: speechRow.defaultVoiceId, voiceName: speechRow.defaultVoiceName } : null,
    },
  };
}
