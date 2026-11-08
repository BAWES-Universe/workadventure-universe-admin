import { Prisma, type VoiceProvider } from '@prisma/client';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { listCompanyModels } from '@/lib/voice-key-check';
import { listedModelJobs, voiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { lendModelId } from '@/lib/voice-lend-model';
import { readModels, type VoiceModel } from '@/lib/voice-providers';
import { readHiddenModels } from '@/lib/voice-hidden-models';

/**
 * Models fill in on their own (voice discovery, 8 Nov 2026): for every voice provider with a key, the server's own and people's own
 * keys alike, the company's own model list is read with that key (the catalog's `modelList`, one free GET per job: nothing is heard or
 * spoken) and every model it lists for what the provider does is added to the provider's models. Nobody types or ticks them.
 *
 * Only added, never taken off: a list cut short or a company that is down for a moment never takes a model away from a bot or a
 * lend. A model taken off by hand is kept in `hiddenModels` so it doesn't come back; adding it back by hand takes it off that list.
 * A company with no list (Fish Audio), a model typed as the person named it (an Azure deployment), and a provider at its own
 * address keep their models as they are.
 */

/** How long a provider's list is trusted before its company is asked again. */
export const DISCOVERY_REFRESH_MS = 10 * 60_000;
/** How long a page waits for the companies before it answers with the models it has (the asking carries on and is saved). */
export const DISCOVERY_WAIT_MS = 4_000;
/** The most models one provider lists, as when one is added by hand. */
const MOST_MODELS = 200;

const askedAt = new Map<string, number>();

/** Forgets when each provider was last asked (tests, and a key that was just replaced). */
export function forgetDiscovery(id?: string): void {
  if (id) askedAt.delete(id);
  else askedAt.clear();
}

/** What the company lists for the provider's key now, or null when there's nothing to read or it couldn't be read. */
async function companyModels(row: VoiceProvider): Promise<VoiceModel[] | null> {
  const company = voiceKeyCompanyInfo(row.adapter);
  // A provider at its own address: the company's address can't vouch for a key made for another one
  const jobs = listedModelJobs(row);
  if (!company || !row.apiKeyEncrypted || jobs.length === 0) return null;
  let key: string;
  try {
    key = decryptApiKey(row.apiKeyEncrypted);
  } catch {
    return null;
  }
  const lists = await Promise.all(jobs.map((job) => listCompanyModels(company, key, job)));
  if (lists.every((list) => list === null)) return null;
  // The short line about each model is for choosing; a provider keeps the id, the label and the job
  return lists.flatMap((list) => list ?? []).map(({ id, label, kind }) => ({ id, ...(label ? { label } : {}), kind }));
}

/** Asks one provider's company and saves the models it lists that are new. */
async function discover(row: VoiceProvider): Promise<void> {
  const found = await companyModels(row);
  if (!found || found.length === 0) return;
  await prisma.$transaction(async (tx) => {
    // Read again: the models may have been changed by hand while the company was asked
    const now = await tx.voiceProvider.findUnique({ where: { id: row.id } });
    if (!now || now.adapter !== row.adapter || now.apiKeyEncrypted !== row.apiKeyEncrypted) return;
    const has = readModels(now.models);
    const known = new Set(has.map(lendModelId));
    const hidden = new Set(readHiddenModels(now.hiddenModels));
    const added = found.filter((model) => !known.has(lendModelId(model)) && !hidden.has(lendModelId(model))).slice(0, Math.max(0, MOST_MODELS - has.length));
    if (added.length === 0) return;
    await tx.voiceProvider.update({ where: { id: row.id }, data: { models: [...has, ...added] as Prisma.InputJsonValue } });
  });
}

/**
 * Fills in the models of these providers from their companies, each at most every 10 minutes, and waits up to `wait` for the
 * answers: what comes later is still saved and shows on the next read. Never throws.
 */
export async function discoverVoiceModels(rows: VoiceProvider[], wait = DISCOVERY_WAIT_MS): Promise<void> {
  const now = Date.now();
  const due = rows.filter((row) => listedModelJobs(row).length > 0 && row.apiKeyEncrypted && now - (askedAt.get(row.id) ?? 0) >= DISCOVERY_REFRESH_MS);
  if (due.length === 0) return;
  for (const row of due) askedAt.set(row.id, now);
  const work = Promise.all(
    due.map((row) =>
      discover(row).catch(() => {
        // Nothing from the error is kept: it could carry the address with the key's header. Asked again on the next read.
        askedAt.delete(row.id);
      }),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
  clearTimeout(timer);
}

/** Fills in the models of the server's own providers that are on. */
export async function discoverServerVoiceModels(wait = DISCOVERY_WAIT_MS): Promise<void> {
  await discoverVoiceModels(await prisma.voiceProvider.findMany({ where: { ownerId: null, enabled: true } }), wait);
}
