import { prisma } from '@/lib/db';
import { KEY_CHARACTERS, KEY_LOOKS_WRONG } from '@/lib/ai-key-models';
import { companyJobs, voiceKeyCompanyInfo, type VoiceCompanyJobName, type VoiceKeyCompanyInfo, type VoiceModelListSpec } from '@/lib/voice-key-companies';
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
  let response: Response | undefined;
  try {
    response = await fetch(check.url, {
      method: check.body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(check.body ? { 'Content-Type': 'application/json' } : {}), ...check.headers, [check.header]: `${check.prefix}${apiKey}` },
      ...(check.body ? { body: JSON.stringify(check.body) } : {}),
      // A redirect would carry the key somewhere the catalog never named
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (response.status >= 200 && response.status < 300) return 'accepted';
    if (check.alsoAccepted && response.status === check.alsoAccepted.status) {
      const wanted = check.alsoAccepted.includes;
      if (wanted === undefined) return 'accepted';
      const text = (await response.text().catch(() => '')).slice(0, 2000);
      if (text.includes(wanted)) return 'accepted';
    }
    return response.status === 401 || response.status === 403 ? 'refused' : 'unreachable';
  } catch {
    // Nothing from the error is kept: it could carry the address with the key's header
    return 'unreachable';
  } finally {
    // A body nobody read holds the connection: let it go (a body already read has nothing left to cancel)
    await response?.body?.cancel().catch(() => undefined);
  }
}

/**
 * The models a company's key may be used with: the union of what the server's own providers for that adapter that are on list,
 * one entry per kind and id (the first listing's label wins), kept to what each provider does. A server with none listed for the
 * company gives the catalog's own starting models, so a company is never without any.
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
  if (seen.size > 0) return [...seen.values()];
  return (voiceKeyCompanyInfo(adapter)?.models ?? []).map((model) => ({ ...model }));
}

/**
 * Checks a pasted key with its company and, when the company accepts it, answers with the models to list. `enabled` is the
 * adapters the caller may add (lib/voice-keys.ts, voiceKeyCompanies): every company in the catalog.
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

/** The most models one company's list may give: more is not a list a person can tick through. */
export const MAX_LISTED_MODELS = 100;

/** A model a company lists, with a short line from what the company says about it, to help choose (never saved). */
export type ListedVoiceModel = VoiceModel & { note?: string };

/** The language codes a model says it covers: plain codes, or `{ code }` / `{ language_id }` objects. */
function languagesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? ((entry as Record<string, unknown>).code ?? (entry as Record<string, unknown>).language_id) : null))
    .filter((code): code is string => typeof code === 'string' && code.trim() !== '')
    .map((code) => code.trim());
}

/** One line about a model from the company's own fields: what it always points to, its languages, its own description. */
function noteOf(spec: VoiceModelListSpec, fields: Record<string, unknown>, languages: string[]): string | undefined {
  const parts: string[] = [];
  const alias = spec.aliasOf && typeof fields[spec.aliasOf] === 'string' ? (fields[spec.aliasOf] as string).trim() : '';
  if (alias) parts.push(`Always the same as ${alias}`);
  if (languages.length === 1) parts.push(`1 language (${languages[0]})`);
  else if (languages.length > 1) parts.push(`${languages.length} languages`);
  const about = spec.about && typeof fields[spec.about] === 'string' ? (fields[spec.about] as string).replace(/\s+/g, ' ').trim() : '';
  if (about) parts.push(about.length > 160 ? `${about.slice(0, 157).trimEnd()}…` : about);
  return parts.length > 0 ? parts.join(' · ').slice(0, 300) : undefined;
}

/**
 * The models a company lists for a key, kept to the ones Universe can run for the company's job (Orbit #840: an operator ticks them
 * instead of typing ids), each with a short line from what the company says about it (what it points to, its languages, its
 * own description) so a person can choose. One free GET to the company's own fixed address with the same key header as the check:
 * nothing is heard or spoken. Null when the company has no list for the job (`modelList` absent from it in the catalog entry), or the list can't be
 * read: then the models are typed, as before. Each id once, in the company's order; a model listed once per language has its
 * languages added up.
 */
export async function listCompanyModels(company: VoiceKeyCompanyInfo, apiKey: string, job?: VoiceCompanyJobName): Promise<ListedVoiceModel[] | null> {
  // Each job has its own list, kept to models that do that job; with none named, the company's first job
  const kind: VoiceModel['kind'] = job ?? companyJobs(company)[0] ?? 'speech';
  const spec = company.jobs[kind]?.modelList;
  if (!spec) return null;
  let response: Response | undefined;
  try {
    response = await fetch(spec.url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...company.check.headers, [company.check.header]: `${company.check.prefix}${apiKey}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (response.status < 200 || response.status >= 300) return null;
    const body: unknown = await response.json();
    const list = spec.list ? (body as Record<string, unknown> | null)?.[spec.list] : body;
    if (!Array.isArray(list)) return null;
    const found = new Map<string, { label: string; fields: Record<string, unknown>; languages: Set<string> }>();
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const fields = entry as Record<string, unknown>;
      if (spec.where && !Object.entries(spec.where).every(([field, value]) => fields[field] === value)) continue;
      const id = typeof fields[spec.id] === 'string' ? (fields[spec.id] as string).trim() : '';
      if (!id || id.length > 255) continue;
      const languages = spec.languages ? languagesOf(fields[spec.languages]) : [];
      const seen = found.get(id);
      if (seen) {
        for (const code of languages) seen.languages.add(code);
        continue;
      }
      if (found.size >= MAX_LISTED_MODELS) continue;
      const label = spec.label && typeof fields[spec.label] === 'string' ? (fields[spec.label] as string).trim().slice(0, 255) : '';
      found.set(id, { label, fields, languages: new Set(languages) });
    }
    const models = [...found.entries()].map(([id, { label, fields, languages }]): ListedVoiceModel => {
      const note = noteOf(spec, fields, [...languages]);
      return { id, ...(label && label !== id ? { label } : {}), kind, ...(note ? { note } : {}) };
    });
    return models.length > 0 ? models : null;
  } catch {
    // Nothing from the error is kept: it could carry the address with the key's header
    return null;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/**
 * Asks a company if it knows a key, with the same free call as "Load models" and nothing else: no model list and no check against
 * which companies people may add. For a super admin setting up Universe's own key (#792): nothing is spoken or heard, so nothing is
 * billed. The key is sent only to the company's own fixed address and is never logged or returned.
 */
export async function checkVoiceKeyWithCompany(adapter: unknown, apiKey: unknown): Promise<{ ok: true } | { ok: false; reason: 'refused' | 'unreachable' | 'bad-request'; message: string }> {
  const company = voiceKeyCompanyInfo(adapter);
  if (!company) return { ok: false, reason: 'bad-request', message: 'Pick a speech company from the list.' };
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'bad-request', message: `Paste the ${company.label} key first.` };
  if (!KEY_CHARACTERS.test(key)) return { ok: false, reason: 'bad-request', message: KEY_LOOKS_WRONG };
  const verdict = await ask(company, key);
  if (verdict === 'refused') return { ok: false, reason: 'refused', message: `${company.label} turned this key away. Check that you copied all of it.` };
  if (verdict === 'unreachable') return { ok: false, reason: 'unreachable', message: `Couldn’t reach ${company.label}. Try again in a moment.` };
  return { ok: true };
}
