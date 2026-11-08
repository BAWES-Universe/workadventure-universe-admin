import { Prisma, type VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { lendAccess, parseLendModels } from '@/lib/ai-key-lend';
import { readModels, voiceProviderProblem, type VoiceModel } from '@/lib/voice-providers';
import { lendModelId } from '@/lib/voice-lend-model';
import { modelChange } from '@/lib/voice-hidden-models';
import { AWS_KEY, TYPED_MODEL, VOICE_KEY_COMPANIES, accountAddress, accountRegion, modelDoes, voiceDoesLine, voiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { startOfMonth } from '@/lib/ai-keys';
import { getVoiceLimits } from '@/lib/voice-limits';
import { checkVoiceKeyLimits, readVoiceKeyLimits, savedVoiceKeyLimits, VOICE_KEY_LIMIT_NAMES, type VoiceKeyLimitValues } from '@/lib/voice-limit-values';
import { healthOf, askForVoiceKeyTry, type VoiceKeyHealth } from '@/lib/voice-key-health';
import { OWN_SPEECH_ENTRY, OWN_SPEECH_LABEL, OWN_SPEECH_NAME, checkOwnSpeechEndpoint, isOwnSpeechAdapter, loadOwnSpeechServer, ownSpeechEndpoint, ownSpeechKey, type OwnSpeechStep } from '@/lib/voice-own-server';

/**
 * Personal voice keys (#749). A key is a VoiceProvider row with an `ownerId`; the rows with none are the server's own
 * providers (lib/voice-providers.ts), which these functions never touch. A person adds a key, lends it to a universe where
 * they have Manage bots, and bots they made there may then listen or speak with it, paid by the key's owner. Lending moves no
 * bot. Nothing here calls a provider (lib/voice-key-check.ts does, once, to check a pasted key): the models a key lists are the ones it is added with.
 */

/** A speech company a person can add a key for, and what it can do. */
export interface VoiceKeyCompany {
  adapter: string;
  label: string;
  recognition: boolean;
  speech: boolean;
  /** It has a talking model, which listens and speaks in one (game #1910). */
  talk: boolean;
  /** From the catalog (lib/voice-key-companies.ts): what the Add a key page shows for it. */
  logo: string | null;
  benefit: string;
  step: string;
  docs: string;
  /** What a key needs besides the key (Azure: the resource's address, and the deployment name typed as its model); null for none. */
  account: {
    address?: { label: string; example: string; hint: string };
    typedModel?: { title: string; label: string; hint: string; kind: 'recognition' | 'speech' | 'talk' };
    regions?: { id: string; label: string; host: string }[];
    keyId?: { label: string; example: string; hint: string };
    keyLabel?: string;
  } | null;
  /**
   * Set for the one entry that is a speech server on the person's own computer, not a company (game #1874): it is added with an
   * https address and an optional key, and these are its setup steps. Absent for every company.
   */
  ownServer?: { steps: OwnSpeechStep[] };
}

/**
 * The speech companies a person can add a key for: every company in the catalog (lib/voice-key-companies.ts), with no setup by a
 * super admin. One entry per company, named and described as the catalog does, doing what the catalog says it does plus whatever
 * a provider the server has switched on for it does (so an operator who runs a company's other job is still covered).
 */
export async function voiceKeyCompanies(): Promise<VoiceKeyCompany[]> {
  const rows = await prisma.voiceProvider.findMany({
    where: { enabled: true, ownerId: null },
    select: { adapter: true, recognition: true, speech: true },
  });
  const companies = VOICE_KEY_COMPANIES.map((info) => {
    const does = { ...info.does };
    for (const row of rows) {
      if (row.adapter !== info.adapter) continue;
      does.recognition ||= row.recognition;
      does.speech ||= row.speech;
    }
    return {
      adapter: info.adapter,
      label: info.label,
      ...does,
      logo: info.logo ?? null,
      benefit: info.benefit.replace('{does}', voiceDoesLine(does)),
      step: info.step,
      docs: info.docs,
      account: info.account
        ? {
            ...(info.account.address ? { address: { label: info.account.address.label, example: info.account.address.example, hint: info.account.address.hint } } : {}),
            ...(info.account.typedModel ? { typedModel: info.account.typedModel } : {}),
            ...(info.account.regions ? { regions: info.account.regions } : {}),
            ...(info.account.keyId ? { keyId: info.account.keyId } : {}),
            ...(info.account.keyLabel ? { keyLabel: info.account.keyLabel } : {}),
          }
        : null,
    };
  });
  // The own speech server is not a company: it comes last, and the page shows it in a group of its own. What it does is up to the server.
  return [
    ...companies,
    {
      adapter: OWN_SPEECH_ENTRY.adapter,
      label: OWN_SPEECH_ENTRY.label,
      recognition: true,
      speech: true,
      // An own server listens or speaks; no talking model (game #1910)
      talk: false,
      logo: null,
      benefit: OWN_SPEECH_ENTRY.benefit,
      account: null,
      step: '',
      docs: '',
      ownServer: { steps: OWN_SPEECH_ENTRY.steps.map((step) => ({ ...step })) },
    },
  ];
}

const modelSchema = z.object({
  id: z.string().trim().min(1, 'A model needs an id').max(255),
  label: z.string().trim().max(255).optional(),
  kind: z.enum(['recognition', 'speech', 'talk']),
});
const fields = {
  name: z.string().trim().min(1, 'name is required').max(255),
  apiKey: z.string().trim().min(8, 'apiKey looks too short').max(2000),
  // A server on the person's own computer may take a short key, or none
  ownApiKey: z.string().trim().max(2000),
  address: z.string().trim().min(1, 'Paste the https address of your server.').max(2000),
  models: z.array(modelSchema).max(200, 'A key can list up to 200 models'),
};

export const createVoiceKeySchema = z
  .object({
    adapter: z.string().trim().min(1, 'Pick a speech company from the list').max(50),
    name: fields.name.optional(),
    recognition: z.boolean().default(false),
    speech: z.boolean().default(false),
    // A company's key is needed and at least 8 characters; an own speech server's is optional (checked in createVoiceKey)
    apiKey: fields.ownApiKey.optional(),
    address: fields.address.optional(),
    models: fields.models.default([]),
    /** The person's own account address, for a company whose keys live there (Azure: the resource's endpoint). */
    endpoint: z.string().trim().max(500).optional(),
    /** The region picked, for a company whose keys are made per region (AWS). */
    region: z.string().trim().max(50).optional(),
  })
  .strict();

export const updateVoiceKeySchema = z
  .object({ name: fields.name, apiKey: fields.ownApiKey.min(1, 'apiKey looks too short'), models: fields.models, takenOff: z.array(z.string().min(1).max(300)).max(1000), limits: z.record(z.string(), z.unknown()), address: fields.address })
  .partial()
  .strict();

/** A key that can't be saved or lent as asked, with the line that says why (shown as it is). */
export class VoiceKeyRefused extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

export { lendModelId };

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
  /** The last four characters of the key; null for a server with no key. */
  last4: string | null;
  /** The host of an own speech server's address, e.g. "speech.example.com"; null for a company's key. */
  address: string | null;
  models: VoiceModel[];
  /** The universes it is lent to, and which of its models bots there may use ("kind:id", null for all of them). */
  lentTo: {
    universeId: string;
    universeName: string;
    ownedByYou: boolean;
    models: string[] | null;
    /**
     * The bots there whose published voice names this key for listening or speaking, each with the model it uses on it (the
     * speaking model if the key speaks for that bot, else the listening one) and its voice replies this month.
     */
    bots: { id: string; name: string; model: string | null; voiceReplies: number }[];
  }[];
  /**
   * The limits of bots that use this key (#783): longest spoken turn (seconds), longest spoken reply (characters and seconds) and
   * minutes a day one bot listens. Each is the value that applies, the server's current voice limit for it (the recommended one),
   * and whether the owner changed it.
   */
  limits: VoiceKeyLimitValues;
  /** What the key paid for this month (UTC, as a text key's): voice replies, one for each spoken reply a bot's call reported working. */
  month: { voiceReplies: number };
  createdAt: string;
  /** Whether the key works: Down once its provider turned it away (out of credit, rejected, repeated errors). Bots on it reply in text meanwhile. */
  health: VoiceKeyHealth;
}

type KeyRow = VoiceProvider & { lends: { models: Prisma.JsonValue; universe: { id: string; name: string; ownerId: string } }[] };

/** How the key is named: its company's name from the catalog, else the adapter as it is. */
const companyName = (adapter: string) => (isOwnSpeechAdapter(adapter) ? OWN_SPEECH_LABEL : (voiceKeyCompanyInfo(adapter)?.label ?? adapter));

/** The host of a saved address, for showing: never the path. */
function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/** Which provider a published voice names for each job. Read loosely: lib/bot-voice.ts owns the profile's shape and imports this file. */
function namedProviders(profile: unknown): { part: 'recognition' | 'speech'; providerId: string; model: string }[] {
  const named: { part: 'recognition' | 'speech'; providerId: string; model: string }[] = [];
  if (typeof profile !== 'object' || profile === null) return named;
  for (const part of ['recognition', 'speech'] as const) {
    const choice = (profile as Record<string, unknown>)[part];
    if (typeof choice !== 'object' || choice === null) continue;
    const { providerId, model } = choice as { providerId?: unknown; model?: unknown };
    if (typeof providerId === 'string' && typeof model === 'string') named.push({ part, providerId, model });
  }
  return named;
}

type BotOnKey = VoiceKeySummary['lentTo'][number]['bots'][number];

/**
 * What the AI keys page shows for these keys: each with what it paid for this month and the bots on it. A bot is on a key when
 * it has voice on and its published voice (the revision named in `bots.voice_revision`) names the key, in a universe the key is
 * lent to.
 */
async function summaries(rows: KeyRow[], ownerId: string): Promise<VoiceKeySummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const month = startOfMonth();
  const universeIds = [...new Set(rows.flatMap((row) => row.lends.map((lend) => lend.universe.id)))];
  const server = (await getVoiceLimits()).limits;
  const [usage, bots] = await Promise.all([
    prisma.voiceKeyUsage.findMany({ where: { providerId: { in: ids }, month }, select: { providerId: true, botId: true, replies: true } }),
    universeIds.length === 0
      ? []
      : prisma.bot.findMany({
          // Voice switched off keeps its revision, so only bots with voice on are on a key (as the Universe AI page counts them)
          where: { voiceEnabled: true, voiceRevision: { not: null }, room: { world: { universeId: { in: universeIds } } } },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, voiceRevision: true, room: { select: { world: { select: { universeId: true } } } } },
        }),
  ]);
  const revisions =
    bots.length === 0
      ? []
      : await prisma.botVoiceRevision.findMany({
          where: { OR: bots.map((bot) => ({ botId: bot.id, number: bot.voiceRevision as number })) },
          select: { botId: true, profile: true },
        });
  const profileOf = new Map(revisions.map((revision) => [revision.botId, revision.profile]));
  const spent = new Map<string, number>();
  const repliesOf = new Map<string, number>();
  for (const entry of usage) {
    spent.set(entry.providerId, (spent.get(entry.providerId) ?? 0) + entry.replies);
    repliesOf.set(`${entry.providerId}:${entry.botId}`, entry.replies);
  }
  return rows.map((row) => {
    const models = readModels(row.models);
    const label = (kind: 'recognition' | 'speech', id: string) => {
      const found = models.find((model) => modelDoes(model, kind) && model.id === id);
      return found ? found.label || found.id : id;
    };
    const botsIn = (universeId: string): BotOnKey[] =>
      bots
        .filter((bot) => bot.room.world.universeId === universeId)
        .flatMap((bot) => {
          const named = namedProviders(profileOf.get(bot.id)).filter((choice) => choice.providerId === row.id);
          if (named.length === 0) return [];
          const chosen = named.find((choice) => choice.part === 'speech') ?? named[0];
          return [{ id: bot.id, name: bot.name, model: label(chosen.part, chosen.model), voiceReplies: repliesOf.get(`${row.id}:${bot.id}`) ?? 0 }];
        });
    return {
      id: row.id,
      adapter: row.adapter,
      company: companyName(row.adapter),
      name: row.name,
      recognition: row.recognition,
      speech: row.speech,
      last4: row.apiKeyLast4,
      address: isOwnSpeechAdapter(row.adapter) ? hostOf(row.endpoint) : null,
      models,
      lentTo: row.lends.map((lend) => ({
        universeId: lend.universe.id,
        universeName: lend.universe.name,
        ownedByYou: lend.universe.ownerId === ownerId,
        models: readLendModels(lend.models),
        bots: botsIn(lend.universe.id),
      })),
      month: { voiceReplies: spent.get(row.id) ?? 0 },
      limits: readVoiceKeyLimits(row.voiceLimits, server),
      createdAt: row.createdAt.toISOString(),
      health: healthOf(row),
    };
  });
}

const summary = async (row: KeyRow, ownerId: string): Promise<VoiceKeySummary> => (await summaries([row], ownerId))[0];

const include = { lends: { orderBy: { lentAt: 'asc' as const }, select: { models: true, universe: { select: { id: true, name: true, ownerId: true } } } } };

/** The caller's own voice keys, oldest first. */
export async function listVoiceKeys(ownerId: string): Promise<VoiceKeySummary[]> {
  const rows = await prisma.voiceProvider.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' }, include });
  return summaries(rows, ownerId);
}

const owned = (id: string, ownerId: string) => prisma.voiceProvider.findFirst({ where: { id, ownerId }, include });

/** The problem a key's job and models have, or null: a key listens, speaks or both, and lists models only for what it does. */
const problem = (draft: { recognition: boolean; speech: boolean; models: VoiceModel[] }) =>
  voiceProviderProblem({ ...draft, enabled: true, defaultRecognition: false, defaultSpeech: false, hasKey: true });

/** A model typed as the person named it (an Azure deployment): one, of the company's job, named the way the company allows. */
function checkTypedModel(adapter: string, models: VoiceModel[]): void {
  const typed = voiceKeyCompanyInfo(adapter)?.account?.typedModel;
  if (typed && (models.length !== 1 || models[0].kind !== typed.kind || !TYPED_MODEL.test(models[0].id))) {
    throw new VoiceKeyRefused(`Type the ${typed.label.toLowerCase()}: letters, digits, dots, dashes and underscores, up to 64`);
  }
}

export async function createVoiceKey(ownerId: string, input: z.infer<typeof createVoiceKeySchema>): Promise<VoiceKeySummary> {
  const refused = problem(input);
  if (refused) throw new VoiceKeyRefused(refused);
  const company = (await voiceKeyCompanies()).find((entry) => entry.adapter === input.adapter);
  if (!company) throw new VoiceKeyRefused('Pick a speech company from the list');
  const own = isOwnSpeechAdapter(company.adapter);
  // What is saved for the key: a company's own address is fixed, an own server's is the one typed (checked public, and saved as its origin with /v1)
  const info = voiceKeyCompanyInfo(input.adapter);
  let endpoint: string | null = null;
  let region: string | null = null;
  let apiKey: string | null = null;
  if (own) {
    const typed = ownSpeechEndpoint(input.address);
    if (!typed.ok) throw new VoiceKeyRefused(typed.message);
    const target = await checkOwnSpeechEndpoint(typed.endpoint);
    if (!target.ok) throw new VoiceKeyRefused(target.message);
    const key = ownSpeechKey(input.apiKey);
    if (!key.ok) throw new VoiceKeyRefused(key.message);
    if (!input.recognition && !input.speech) throw new VoiceKeyRefused('Pick what the server does: listens, speaks or both.');
    endpoint = typed.endpoint;
    apiKey = key.key || null;
  } else {
    if (input.address !== undefined) throw new VoiceKeyRefused(`${company.label} has its own address.`);
    if (!input.apiKey || input.apiKey.length < 8) throw new VoiceKeyRefused('apiKey looks too short');
    // A company with a talking model listens and speaks with it (game #1910)
    const can = { recognition: company.recognition || company.talk, speech: company.speech || company.talk };
    if ((input.recognition && !can.recognition) || (input.speech && !can.speech)) {
      throw new VoiceKeyRefused(`${company.label} doesn’t do ${input.recognition && !can.recognition ? 'listening' : 'speaking'}`);
    }
    apiKey = input.apiKey;
    // A key that lives at the person's own account address (Azure) keeps that address, checked; no other company key has one
    if (info?.account?.address) {
      endpoint = accountAddress(info, input.endpoint);
      if (!endpoint) throw new VoiceKeyRefused(`Paste your ${info.account.address.label.toLowerCase()} as it is, like ${info.account.address.example}`);
    } else if (input.endpoint !== undefined) {
      throw new VoiceKeyRefused(`${company.label} keys don’t take an address`);
    }
    // A key made per region (AWS) keeps the region picked, one of the company's own; no other key has one
    if (info?.account?.regions) {
      region = accountRegion(info, input.region);
      if (!region) throw new VoiceKeyRefused('Pick the region');
    } else if (input.region !== undefined) {
      throw new VoiceKeyRefused(`${company.label} keys don’t take a region`);
    }
    // A key in two parts (AWS) is kept as one: the access key ID, a colon, the secret
    if (info?.account?.keyId && !AWS_KEY.test(input.apiKey)) throw new VoiceKeyRefused(`Paste the ${info.account.keyId.label.toLowerCase()} and the ${(info.account.keyLabel ?? 'key').toLowerCase()} as AWS shows them`);
  }
  if (input.models.some((model) => model.kind === 'talk') && !company.talk) throw new VoiceKeyRefused(`${company.label} doesn’t talk live`);
  checkTypedModel(input.adapter, input.models);
  const row = await prisma.voiceProvider.create({
    data: {
      adapter: input.adapter,
      name: input.name ?? (own ? OWN_SPEECH_NAME : company.label),
      recognition: input.recognition,
      speech: input.speech,
      // A person's own key is on from the start: it only reaches bots they made, in universes they lend it to
      enabled: true,
      endpoint,
      region,
      apiKeyEncrypted: apiKey ? encryptApiKey(apiKey) : null,
      apiKeyLast4: apiKey && !own ? apiKey.slice(-4) : null,
      models: input.models as Prisma.InputJsonValue,
      ownerId,
      createdById: ownerId,
    },
    include,
  });
  return summary(row, ownerId);
}

/** A key or address changed: its record of failures starts clean, so it is tried at once, not after the old one's wait. */
const CLEAN_HEALTH = { downSince: null, downReason: null, downPart: null, failedRecognition: 0, failedSpeech: 0, healthCheckedAt: null };

/**
 * Where an own speech server now answers (a cloudflared tunnel gets a new address when it restarts). Nothing is saved until the
 * new address is public, answers its model list with the saved key, and lists every model the key already has: a bot on the old
 * address carries on with the same models, and a different server is a new key.
 */
async function movedAddress(row: VoiceProvider, address: string, newKey?: string): Promise<string> {
  if (!isOwnSpeechAdapter(row.adapter)) throw new VoiceKeyRefused(`${companyName(row.adapter)} can’t be moved to another address.`);
  // A key changed in the same request is the one the new address is asked with
  let key = newKey ?? '';
  if (newKey === undefined && row.apiKeyEncrypted) {
    try {
      key = decryptApiKey(row.apiKeyEncrypted);
    } catch {
      throw new VoiceKeyRefused('This key can’t be read. Add the server again.', 409);
    }
  }
  const loaded = await loadOwnSpeechServer(address, key);
  if (!loaded.ok) throw new VoiceKeyRefused(loaded.message, loaded.reason === 'unreachable' ? 409 : 400);
  const there = loaded.listed;
  const missing = readModels(row.models).find((model) => !there.has(model.id));
  if (missing) throw new VoiceKeyRefused(`That address doesn’t have ${missing.id}. If it is another server, add it as a new key.`);
  const typed = ownSpeechEndpoint(address);
  if (!typed.ok) throw new VoiceKeyRefused(typed.message);
  return typed.endpoint;
}

/** Changes only what is named. A model taken off the key is taken off every lend that named it; a lend left with none is pulled. */
export async function updateVoiceKey(ownerId: string, id: string, input: z.infer<typeof updateVoiceKeySchema>): Promise<VoiceKeySummary> {
  // The new address is asked outside the save: a slow server never holds the database
  let endpoint: string | undefined;
  if (input.address !== undefined || input.apiKey !== undefined) {
    const current = await prisma.voiceProvider.findFirst({ where: { id, ownerId } });
    if (!current) throw new VoiceKeyRefused('Key not found', 404);
    if (input.apiKey !== undefined) {
      // A company's key is at least 8 characters; an own server's may be short, but is held to what a header can carry, as when it was added
      if (isOwnSpeechAdapter(current.adapter)) {
        const key = ownSpeechKey(input.apiKey);
        if (!key.ok) throw new VoiceKeyRefused(key.message);
      } else if (input.apiKey.length < 8) {
        throw new VoiceKeyRefused('apiKey looks too short');
      }
    }
    if (input.address !== undefined) endpoint = await movedAddress(current, input.address, input.apiKey);
  }
  await prisma.$transaction(async (tx) => {
    const row = await tx.voiceProvider.findFirst({ where: { id, ownerId } });
    if (!row) throw new VoiceKeyRefused('Key not found', 404);
    // A key in two parts (AWS) is replaced whole: the access key ID, a colon, the secret
    const keyId = voiceKeyCompanyInfo(row.adapter)?.account?.keyId;
    if (input.apiKey !== undefined && keyId && !AWS_KEY.test(input.apiKey)) throw new VoiceKeyRefused(`Paste the ${keyId.label.toLowerCase()}, a colon, then the secret`);
    // A model the company's list added while the page was open is kept, not taken off with the ones named
    const changed = input.models !== undefined ? modelChange(readModels(row.models), input.models, input.takenOff, row.hiddenModels) : null;
    const models = changed?.models ?? readModels(row.models);
    const refused = problem({ recognition: row.recognition, speech: row.speech, models });
    if (refused) throw new VoiceKeyRefused(refused);
    // As when it was added: a talking model only on a key from a company that talks live (an own server never does)
    const talksLive = Boolean(voiceKeyCompanyInfo(row.adapter)?.does.talk);
    if (input.models !== undefined && !talksLive && models.some((model) => model.kind === 'talk')) throw new VoiceKeyRefused(`${companyName(row.adapter)} doesn’t talk live`);
    if (input.models !== undefined) checkTypedModel(row.adapter, models);
    // Only what the owner changed is kept: a value picked that is the server's own now is dropped, so it follows the server from then on.
    // Only the names sent are looked at: a limit saved earlier that happens to equal the server's today stays saved
    let voiceLimits: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
    if (input.limits !== undefined) {
      const checked = checkVoiceKeyLimits(input.limits);
      if (!checked.ok) throw new VoiceKeyRefused(checked.error);
      const server = (await getVoiceLimits()).limits;
      const next: Record<string, number> = { ...savedVoiceKeyLimits(row.voiceLimits), ...checked.value } as Record<string, number>;
      for (const name of VOICE_KEY_LIMIT_NAMES) if (name in checked.value && next[name] === server[name]) delete next[name];
      voiceLimits = Object.keys(next).length > 0 ? next : Prisma.DbNull;
    }
    await tx.voiceProvider.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        // A new key starts clean: it is tried at once, not after the old one's wait
        ...(input.apiKey !== undefined
          ? { apiKeyEncrypted: encryptApiKey(input.apiKey), apiKeyLast4: isOwnSpeechAdapter(row.adapter) ? null : input.apiKey.slice(-4), ...CLEAN_HEALTH }
          : {}),
        // A new address is a new connection: tried at once too
        ...(endpoint !== undefined ? { endpoint, ...CLEAN_HEALTH } : {}),
        // A model taken off by hand stays off when the company's list is read again; one added back by hand comes back
        ...(changed ? { models: changed.models as Prisma.InputJsonValue, hiddenModels: (changed.hidden ?? Prisma.DbNull) as Prisma.InputJsonValue } : {}),
        ...(voiceLimits !== undefined ? { voiceLimits } : {}),
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
  return summary(row, ownerId);
}

/** Takes the key away, and with it every lend. Bots whose voice named it carry on in text (their voice no longer works). */
export async function deleteVoiceKey(ownerId: string, id: string): Promise<void> {
  const removed = await prisma.voiceProvider.deleteMany({ where: { id, ownerId } });
  if (removed.count === 0) throw new VoiceKeyRefused('Key not found', 404);
}

/**
 * Lends the key to a universe where the caller owns it or has Manage bots. `models` (undefined = as it is, all for a new lend;
 * null = all; a list of "kind:id") says which of the key's models bots there may use. Lending again changes nothing but the list.
 * `existing` changes a lend only: when there is none (pulled meanwhile) nothing is lent and it is refused with a 409.
 */
export async function lendVoiceKey(ownerId: string, id: string, universeId: string, rawModels: unknown, existing = false): Promise<VoiceKeySummary> {
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
    // A change of a lend (`existing`) never lends again: one removed meanwhile, in another tab or by the universe, stays removed
    if (existing) await prisma.voiceKeyLend.update({ where, data: update });
    else await prisma.voiceKeyLend.upsert({ where, create: { providerId: id, universeId, ...(models ? { models } : {}) }, update });
  } catch (error) {
    // The key was deleted, or the universe, between the checks above and the save
    if ((error as { code?: unknown })?.code === 'P2003') throw new VoiceKeyRefused('Key or universe not found', 404);
    if (existing && (error as { code?: unknown })?.code === 'P2025') {
      throw new VoiceKeyRefused('This key isn’t lent to that universe any more. Reload the page to see where it’s lent.', 409);
    }
    throw error;
  }
  const row = await owned(id, ownerId);
  if (!row) throw new VoiceKeyRefused('Key not found', 404);
  return summary(row, ownerId);
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
  return summary(fresh, ownerId);
}
