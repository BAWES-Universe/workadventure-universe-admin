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
/**
 * How soon a provider is asked again after its company's list couldn't be read (down for a moment, too slow, an error): each
 * failure in a row doubles it, up to DISCOVERY_REFRESH_MS, so a company that just came back is asked again soon and one that keeps
 * refusing is not asked on every page read.
 */
export const DISCOVERY_RETRY_MS = 30_000;
/** How long a page waits for the companies before it answers with the models it has (the asking carries on and is saved). */
export const DISCOVERY_WAIT_MS = 4_000;
/** The most models one provider lists, as when one is added by hand. */
const MOST_MODELS = 200;

/** When each provider may be asked next, and how many times in a row its company's list couldn't be read. */
const nextAsk = new Map<string, { at: number; failures: number }>();

/** Forgets when each provider was last asked (tests, and a key that was just replaced). */
export function forgetDiscovery(id?: string): void {
  if (id) nextAsk.delete(id);
  else nextAsk.clear();
}

/** How long to wait after this many failures in a row: DISCOVERY_RETRY_MS, doubled for each one after the first, never past the refresh. */
export function discoveryRetryDelay(failures: number): number {
  return Math.min(DISCOVERY_RETRY_MS * 2 ** Math.max(0, failures - 1), DISCOVERY_REFRESH_MS);
}

/**
 * What the company lists for the provider's key now: `read` with every job's list, `failed` when a list couldn't be read (the
 * models of the jobs that were read still come back, to be saved), or `none` when there's nothing to read.
 */
type CompanyAnswer = { outcome: 'read' | 'failed'; models: VoiceModel[] } | { outcome: 'none' };

async function companyModels(row: VoiceProvider): Promise<CompanyAnswer> {
  const company = voiceKeyCompanyInfo(row.adapter);
  // A provider at its own address: the company's address can't vouch for a key made for another one
  const jobs = listedModelJobs(row);
  if (!company || !row.apiKeyEncrypted || jobs.length === 0) return { outcome: 'none' };
  let key: string;
  try {
    key = decryptApiKey(row.apiKeyEncrypted);
  } catch {
    return { outcome: 'none' };
  }
  const lists = await Promise.all(jobs.map((job) => listCompanyModels(company, key, job)));
  // The short line about each model is for choosing; a provider keeps the id, the label and the job
  const models = lists.flatMap((list) => list ?? []).map(({ id, label, kind }): VoiceModel => ({ id, ...(label ? { label } : {}), kind }));
  return { outcome: lists.some((list) => list === null) ? 'failed' : 'read', models };
}

/** Asks one provider's company and saves the models it lists that are new. Says whether the company's lists were read. */
async function discover(row: VoiceProvider): Promise<'read' | 'failed' | 'none'> {
  const answer = await companyModels(row);
  if (answer.outcome === 'none' || answer.models.length === 0) return answer.outcome;
  const found = answer.models;
  await prisma.$transaction(async (tx) => {
    // The row is held until this is saved, as a change by hand holds it (updateVoiceProvider, updateVoiceKey): one waits for the
    // other, so neither saves over the other's models or the ones taken off by hand
    await tx.$queryRaw`SELECT 1 FROM "voice_providers" WHERE "id" = ${row.id} FOR UPDATE`;
    // Read again: the provider may have been changed by hand while the company was asked
    const now = await tx.voiceProvider.findUnique({ where: { id: row.id } });
    if (!now || now.adapter !== row.adapter || now.apiKeyEncrypted !== row.apiKeyEncrypted) return;
    // Only for the jobs it still lists models for: a job switched off or an address typed meanwhile takes its models out of this answer
    const jobs = new Set<string>(listedModelJobs(now));
    const has = readModels(now.models);
    const known = new Set(has.map(lendModelId));
    const hidden = new Set(readHiddenModels(now.hiddenModels));
    const added = found
      .filter((model) => jobs.has(model.kind) && !known.has(lendModelId(model)) && !hidden.has(lendModelId(model)))
      .slice(0, Math.max(0, MOST_MODELS - has.length));
    if (added.length === 0) return;
    await tx.voiceProvider.update({ where: { id: row.id }, data: { models: [...has, ...added] as Prisma.InputJsonValue } });
  });
  return answer.outcome;
}

/**
 * Fills in the models of these providers from their companies, each at most every 10 minutes (sooner after a list that couldn't
 * be read, see DISCOVERY_RETRY_MS), and waits up to `wait` for the answers: what comes later is still saved and shows on the next
 * read. Never throws.
 */
export async function discoverVoiceModels(rows: VoiceProvider[], wait = DISCOVERY_WAIT_MS): Promise<void> {
  const now = Date.now();
  const due = rows.filter((row) => listedModelJobs(row).length > 0 && row.apiKeyEncrypted && now >= (nextAsk.get(row.id)?.at ?? 0));
  if (due.length === 0) return;
  const work = Promise.all(
    due.map((row) => {
      // Not asked again while this asking is on its way
      const asking = { at: now + DISCOVERY_REFRESH_MS, failures: nextAsk.get(row.id)?.failures ?? 0 };
      nextAsk.set(row.id, asking);
      return (
        discover(row)
          // Nothing from an error is kept: it could carry the address with the key's header
          .catch(() => 'failed' as const)
          .then((outcome) => {
            // Forgotten meanwhile (a new key): the next read asks at once, whatever the old key's answer was
            if (nextAsk.get(row.id) !== asking) return;
            const failures = outcome === 'failed' ? asking.failures + 1 : 0;
            nextAsk.set(row.id, { at: Date.now() + (failures > 0 ? discoveryRetryDelay(failures) : DISCOVERY_REFRESH_MS), failures });
          })
      );
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
  clearTimeout(timer);
}

/** Fills in the models of the server's own providers that are on. */
export async function discoverServerVoiceModels(wait = DISCOVERY_WAIT_MS): Promise<void> {
  await discoverVoiceModels(await prisma.voiceProvider.findMany({ where: { ownerId: null, enabled: true } }), wait);
}
