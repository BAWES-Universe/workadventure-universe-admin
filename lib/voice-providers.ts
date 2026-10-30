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
  endpoint: z.string().trim().url('endpoint must be a web address').startsWith('https://', 'endpoint must start with https://').max(2000).nullable(),
  region: z.string().trim().min(1).max(50).nullable(),
  // A new key replaces the saved one; null takes it away
  apiKey: z.string().trim().min(8, 'apiKey looks too short').max(2000).nullable(),
  models: z.array(modelSchema).max(200, 'A provider can list up to 200 models'),
  defaultRecognition: z.boolean(),
  defaultSpeech: z.boolean(),
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
    updatedAt: row.updatedAt,
  };
}

export function readModels(value: unknown): VoiceModel[] {
  const parsed = z.array(modelSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

type Draft = Pick<VoiceProvider, 'recognition' | 'speech' | 'enabled' | 'defaultRecognition' | 'defaultSpeech'> & { models: VoiceModel[]; hasKey: boolean };

/** Why a provider can't be saved like this, or null. A default must be enabled, hold its key and do its job. */
export function voiceProviderProblem(draft: Draft): string | null {
  if (!draft.recognition && !draft.speech) return 'A provider must listen, speak, or both';
  if (draft.models.some((model) => !draft[model.kind])) return 'A model can only be listed for what the provider does';
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

export const listVoiceProviders = () => prisma.voiceProvider.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });

export async function createVoiceProvider(input: z.infer<typeof createVoiceProviderSchema>, userId: string): Promise<VoiceProvider> {
  const problem = voiceProviderProblem({ ...input, defaultRecognition: false, defaultSpeech: false, hasKey: Boolean(input.apiKey) });
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
    if (!row) throw new VoiceProviderRefused('Voice provider not found', 404);
    const next = {
      recognition: input.recognition ?? row.recognition,
      speech: input.speech ?? row.speech,
      enabled: input.enabled ?? row.enabled,
      defaultRecognition: input.defaultRecognition ?? row.defaultRecognition,
      defaultSpeech: input.defaultSpeech ?? row.defaultSpeech,
      models: input.models ?? readModels(row.models),
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
      },
    });
  });
}

/** A default can't be deleted: another is made the default first. */
export async function deleteVoiceProvider(id: string): Promise<void> {
  const row = await prisma.voiceProvider.findUnique({ where: { id } });
  if (!row) throw new VoiceProviderRefused('Voice provider not found', 404);
  if (row.defaultRecognition || row.defaultSpeech) throw new VoiceProviderRefused('Make another provider the default for what this one does first', 409);
  await prisma.voiceProvider.delete({ where: { id } });
}

/** What the bot server reads: the providers that are on, without their keys, and which are the defaults. */
export async function servedVoiceProviders() {
  const rows = await prisma.voiceProvider.findMany({ where: { enabled: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
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
