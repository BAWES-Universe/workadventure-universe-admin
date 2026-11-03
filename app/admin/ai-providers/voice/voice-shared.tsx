'use client';

/*
 * Universe AI voice (#792): what the Voice part of the Universe AI page, New voice provider and a voice provider's page share:
 * the server's voice providers as a super admin reads them, the companies and what each does in Universe, and small pieces of
 * screen (a caption, a tick line, the model list).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { voiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import type { VoiceModel } from '@/lib/voice-providers';

export type VoiceJob = 'recognition' | 'speech';

/** A server voice provider as GET /api/admin/voice-providers gives it (never the key). */
export interface ServerVoiceProvider {
  id: string;
  adapter: string;
  name: string;
  recognition: boolean;
  speech: boolean;
  enabled: boolean;
  endpoint: string | null;
  region: string | null;
  hasKey: boolean;
  apiKeyLast4: string | null;
  models: VoiceModel[];
  defaultRecognition: boolean;
  defaultSpeech: boolean;
  defaultVoiceId: string | null;
  defaultVoiceName: string | null;
  bots: { recognition: number; speech: number };
}

/** The companies a super admin can add, grouped by what each does in Universe (the game's connectors: Soniox and Deepgram listen, ElevenLabs and Cartesia speak). */
export const COMPANY_JOBS: Record<string, VoiceJob> = { soniox: 'recognition', deepgram: 'recognition', elevenlabs: 'speech', cartesia: 'speech' };

/** The company's own address, as the bot server calls it when nothing else is typed. */
export const COMPANY_HOST: Record<string, string> = { soniox: 'stt-rt.soniox.com', deepgram: 'api.deepgram.com', elevenlabs: 'api.elevenlabs.io', cartesia: 'api.cartesia.ai' };

export const JOBS: { job: VoiceJob; word: string; ing: string }[] = [
  { job: 'recognition', word: 'Listens', ing: 'listening' },
  { job: 'speech', word: 'Speaks', ing: 'speaking' },
];

export const logoOf = (adapter: string) => ({ logo: voiceKeyCompanyInfo(adapter)?.logo });
export const companyLabel = (adapter: string) => voiceKeyCompanyInfo(adapter)?.label ?? adapter;

/** "Listens", "Speaks" or "Listens and speaks". */
export const doesLine = (provider: Pick<ServerVoiceProvider, 'recognition' | 'speech'>) =>
  provider.recognition && provider.speech ? 'Listens and speaks' : provider.recognition ? 'Listens' : 'Speaks';

export const modelName = (model: VoiceModel) => model.label || model.id;

/** The model a bot starts on for a job: the first one the provider lists for it. */
export const startingModel = (provider: Pick<ServerVoiceProvider, 'models'>, job: VoiceJob) => provider.models.find((model) => model.kind === job) ?? null;

/** The models with one moved in front of the others of its job: that is how a model becomes the one bots start on. */
export function withStartingModel(models: VoiceModel[], job: VoiceJob, id: string): VoiceModel[] {
  const picked = models.find((model) => model.kind === job && model.id === id);
  if (!picked) return models;
  const first = models.findIndex((model) => model.kind === job);
  return [...models.slice(0, first), picked, ...models.slice(first).filter((model) => model !== picked)];
}

export const bots = (value: number) => `${value.toLocaleString('en')} ${value === 1 ? 'bot' : 'bots'}`;

/** How many bots with voice on use a provider, for either job. */
export const botsOn = (provider: Pick<ServerVoiceProvider, 'bots'>) => provider.bots.recognition + provider.bots.speech;

type Answer<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** One call to Orbit as the signed-in super admin. The error is a sentence to show as it is. */
export async function callOrbit<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<Answer<T>> {
  try {
    const { authenticatedFetch } = await import('@/lib/client-auth');
    const response = await authenticatedFetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, status: response.status, error: (data as { error?: string } | null)?.error || 'That didn’t work. Try again.' };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: 'We couldn’t reach Universe. Check your connection and try again.' };
  }
}

/** The server's voice providers, loaded once and again when asked. */
export function useVoiceProviders() {
  const [providers, setProviders] = useState<ServerVoiceProvider[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    void callOrbit<{ providers: ServerVoiceProvider[] }>('GET', '/api/admin/voice-providers').then((answer) => {
      if (!current) return;
      if (answer.ok) setProviders(answer.data.providers);
      setFailed(!answer.ok);
    });
    return () => {
      current = false;
    };
  }, [round]);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { providers, failed, reload };
}

export const FIELD_HINT = 'text-[13px] text-muted-foreground';

/** Small ALL-CAPS caption, as Orbit's limit groups use. */
export function Caption({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{children}</h3>;
}

/** "Default for listening": neutral, like the text Default pill. */
export function JobDefaultPill({ job }: { job: VoiceJob }) {
  return (
    <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-foreground/15 px-2.5 text-[11px] font-semibold text-foreground/85">
      Default for {job === 'recognition' ? 'listening' : 'speaking'}
    </span>
  );
}

/** The pills for the jobs a provider is the default for. */
export function DefaultPills({ provider }: { provider: Pick<ServerVoiceProvider, 'defaultRecognition' | 'defaultSpeech'> }) {
  return (
    <>
      {provider.defaultRecognition && <JobDefaultPill job="recognition" />}
      {provider.defaultSpeech && <JobDefaultPill job="speech" />}
    </>
  );
}

/** A tick line, as Load models shows. */
export function Answered({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
      <Check size={16} aria-hidden="true" className="text-[#4ade80]" />
      {children}
    </p>
  );
}

export function Refused({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-[#fca5a5]">
      {children}
    </p>
  );
}

/**
 * The models a provider lists, typed as the company writes them. Taking one off asks nothing here: the page that owns the list
 * saves it. A provider that does both jobs lists each job's models under its own small heading and asks which job a new one is for.
 */
export function ModelRows({
  models,
  jobs,
  onChange,
  disabled,
}: {
  models: VoiceModel[];
  /** The jobs the provider does. */
  jobs: VoiceJob[];
  onChange: (models: VoiceModel[]) => void | Promise<void>;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [job, setJob] = useState<VoiceJob>(jobs[0] ?? 'speech');
  const [problem, setProblem] = useState<string | null>(null);
  const grouped = jobs.length > 1;

  function close() {
    setAdding(false);
    setId('');
    setLabel('');
    setProblem(null);
  }

  async function add() {
    const typed = id.trim();
    if (typed === '') return;
    if (models.some((model) => model.kind === job && model.id === typed)) {
      setProblem('That model is already on the list.');
      return;
    }
    await onChange([...models, { id: typed, ...(label.trim() ? { label: label.trim() } : {}), kind: job }]);
    close();
  }

  const row = (entry: VoiceModel) => (
    <li key={`${entry.kind}:${entry.id}`} className="flex min-h-12 items-center gap-2 border-t border-foreground/10 pl-3 text-[15px] first:border-t-0" data-testid="model-row">
      <span className="grid min-w-0 flex-1">
        <span className="[overflow-wrap:anywhere]">{modelName(entry)}</span>
        {entry.label && <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{entry.id}</span>}
      </span>
      <button
        type="button"
        aria-label={`Take ${modelName(entry)} off`}
        disabled={disabled}
        onClick={() => void onChange(models.filter((model) => model !== entry))}
        className="grid h-11 w-11 shrink-0 place-content-center rounded-full hover:bg-foreground/[0.08] disabled:opacity-50"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </li>
  );

  return (
    <>
      {models.length > 0 &&
        (grouped ? (
          JOBS.filter((entry) => jobs.includes(entry.job)).map((entry) => {
            const list = models.filter((model) => model.kind === entry.job);
            return (
              list.length > 0 && (
                <div key={entry.job} className="grid gap-1.5">
                  <Caption>{entry.word}</Caption>
                  <ul className="m-0 grid list-none gap-0 rounded-2xl border border-foreground/10 p-0">{list.map(row)}</ul>
                </div>
              )
            );
          })
        ) : (
          <ul className="m-0 grid list-none gap-0 rounded-2xl border border-foreground/10 p-0">{models.map(row)}</ul>
        ))}
      {adding ? (
        <div className="grid gap-2 rounded-2xl border border-foreground/10 p-3">
          {grouped && (
            <div className="grid gap-1.5" role="radiogroup" aria-label="Model for">
              <span className="text-sm font-medium">For</span>
              <div className="flex gap-2">
                {JOBS.filter((entry) => jobs.includes(entry.job)).map((entry) => (
                  <Button key={entry.job} type="button" variant="outline" role="radio" aria-checked={job === entry.job} className={`h-11 px-5 ${job === entry.job ? 'border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)]' : ''}`} onClick={() => setJob(entry.job)}>
                    {entry.word}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="model-id">Model id</Label>
            <Input id="model-id" value={id} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={255} onChange={(event) => setId(event.target.value)} className="h-11 rounded-xl" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="model-label">Name people see (optional)</Label>
            <Input id="model-label" value={label} maxLength={255} onChange={(event) => setLabel(event.target.value)} className="h-11 rounded-xl" />
          </div>
          {problem && <Refused>{problem}</Refused>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="h-11 px-5" onClick={close}>
              Cancel
            </Button>
            <Button type="button" variant="outline" className="h-11 px-5" disabled={id.trim() === '' || disabled} onClick={() => void add()}>
              Add model
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" className="h-11 w-fit px-5" disabled={disabled} onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          Add a model
        </Button>
      )}
    </>
  );
}
