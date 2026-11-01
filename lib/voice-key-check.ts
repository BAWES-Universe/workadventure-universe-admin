import { prisma } from '@/lib/db';
import { KEY_CHARACTERS, KEY_LOOKS_WRONG } from '@/lib/ai-key-models';
import { voiceKeyCompanyInfo, type VoiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { readModels, type VoiceModel } from '@/lib/voice-providers';

/**
 * "Load models" for a voice key (#749): one free, authenticated call to the company with the pasted key (the `check` of its
 * catalog entry, lib/voice-key-companies.ts), to see that the company accepts it. Nothing is transcribed or spoken, so nothing is
 * billed. The key goes only in that one header to the company's own fixed address, and is never logged or returned. The models
 * shown are the ones the server's own providers for that company list, so a model id is exactly what the bot server calls.
 */

/** How long the company has to answer. */
export const CHECK_TIMEOUT_MS = 8_000;

export type VoiceKeyLoad =
  | { ok: true; models: VoiceModel[] }
  | { ok: false; reason: 'refused' | 'unreachable' | 'bad-request' | 'no-models'; message: string };

/** What the company said about the key: accepted, turned it away, or nothing useful (so "try again"). */
type Verdict = 'accepted' | 'refused' | 'unreachable';

async function ask(company: VoiceKeyCompanyInfo, apiKey: string): Promise<Verdict> {
  const { check } = company;
  try {
    const response = await fetch(check.url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...check.headers, [check.header]: `${check.prefix}${apiKey}` },
      // A redirect would carry the key somewhere the catalog never named
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (response.status >= 200 && response.status < 300) return 'accepted';
    if (check.alsoAccepted && response.status === check.alsoAccepted.status) {
      const text = (await response.text().catch(() => '')).slice(0, 2000);
      if (text.includes(check.alsoAccepted.includes)) return 'accepted';
    }
    return response.status === 401 || response.status === 403 ? 'refused' : 'unreachable';
  } catch {
    // Nothing from the error is kept: it could carry the address with the key's header
    return 'unreachable';
  }
}

/**
 * The models a company's key may be used with: the union of what the server's own providers for that adapter that are on list,
 * one entry per kind and id (the first listing's label wins), kept to what each provider does.
 */
export async function serverVoiceModels(adapter: string): Promise<VoiceModel[]> {
  const rows = await prisma.voiceProvider.findMany({
    where: { enabled: true, ownerId: null, adapter },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { recognition: true, speech: true, models: true },
  });
  const seen = new Map<string, VoiceModel>();
  for (const row of rows) {
    for (const model of readModels(row.models)) {
      if (!row[model.kind]) continue;
      const id = `${model.kind}:${model.id}`;
      if (!seen.has(id)) seen.set(id, model);
    }
  }
  return [...seen.values()];
}

/**
 * Checks a pasted key with its company and, when the company accepts it, answers with the models to list. `enabled` is the
 * adapters the caller may add (lib/voice-keys.ts, voiceKeyCompanies): a company the super admin has not turned on is refused
 * before any call is made.
 */
export async function loadVoiceKeyModels(adapter: unknown, apiKey: unknown, enabled: string[]): Promise<VoiceKeyLoad> {
  const company = voiceKeyCompanyInfo(adapter);
  if (!company || !enabled.includes(company.adapter)) return { ok: false, reason: 'bad-request', message: 'Pick a speech company from the list.' };
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'bad-request', message: `Paste your ${company.label} key first.` };
  if (!KEY_CHARACTERS.test(key)) return { ok: false, reason: 'bad-request', message: KEY_LOOKS_WRONG };
  const verdict = await ask(company, key);
  if (verdict === 'refused') return { ok: false, reason: 'refused', message: `${company.label} didn’t accept that key. Check it and paste it again.` };
  if (verdict === 'unreachable') return { ok: false, reason: 'unreachable', message: `Couldn’t reach ${company.label}. Try again in a moment.` };
  const models = await serverVoiceModels(company.adapter);
  if (models.length === 0) return { ok: false, reason: 'no-models', message: `${company.label} has no models set up here yet.` };
  return { ok: true, models };
}
