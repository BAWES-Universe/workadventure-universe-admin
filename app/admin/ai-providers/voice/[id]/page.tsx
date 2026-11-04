'use client';

import { use, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import type { VoiceModel } from '@/lib/voice-providers';
import { LoadError, LoadingRows, PageHeader, SettingSwitch, Settings } from '../../../components/ds';
import { ProviderLogo } from '../../../components/ds/provider-logo';
import { FormSheet } from '../../../components/form-sheet';
import { EnabledPill } from '../../components/provider-state';
import {
  Answered,
  COMPANY_HOST,
  Caption,
  DefaultPills,
  FIELD_HINT,
  ModelRows,
  Refused,
  bots,
  botsOn,
  callOrbit,
  companyLabel,
  doesLine,
  logoOf,
  modelName,
  startingModel,
  type ServerVoiceProvider,
  type VoiceJob,
} from '../voice-shared';

/** A fact with one button: what it is now and what changes it (the address, the name). */
function ValueRow({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-foreground/[.04] py-1 pl-3 pr-1">
      <span className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">{children}</span>
      {action}
    </div>
  );
}

/** A value being changed in place: one field with Save and Cancel, and what went wrong. */
function EditField({
  label,
  initial,
  type = 'text',
  placeholder,
  hint,
  save,
  onCancel,
  go = 'Save',
}: {
  label: string;
  initial: string;
  type?: string;
  placeholder?: string;
  hint?: ReactNode;
  save: (value: string) => Promise<string | null>;
  onCancel: () => void;
  go?: string;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setProblem(null);
        const refused = await save(value.trim());
        setBusy(false);
        if (refused) setProblem(refused);
      }}
    >
      <Input aria-label={label} type={type} autoComplete="off" spellCheck={false} placeholder={placeholder} value={value} onChange={(event) => setValue(event.target.value)} className="h-11 rounded-xl" />
      {hint && <p className={FIELD_HINT}>{hint}</p>}
      {problem && <Refused>{problem}</Refused>}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" className="h-11 px-5" disabled={busy}>
          {busy ? 'Saving…' : go}
        </Button>
        <Button type="button" variant="outline" className="h-11 px-5" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const verbFor = (provider: ServerVoiceProvider) => (provider.recognition && provider.speech ? 'listen and speak' : provider.recognition ? 'listen' : 'speak');

/** A voice provider's own page (#792): on or off, who uses it, its key, models, address, name and delete. */
export default function VoiceProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const replacePage = useReplacePage();
  const { addToast } = useToast();
  const [provider, setProvider] = useState<ServerVoiceProvider | null>(null);
  const [all, setAll] = useState<ServerVoiceProvider[]>([]);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState<{ ok: true } | { ok: false; message: string } | { ok: 'note'; message: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState<'key' | 'address' | 'name' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    // The list says how many bots use each provider, which one provider's own route doesn't
    void callOrbit<{ providers: ServerVoiceProvider[] }>('GET', '/api/admin/voice-providers').then((answer) => {
      if (!current) return;
      if (!answer.ok) {
        if (answer.status === 401 || answer.status === 403) return replacePage('/admin');
        return setFailed(true);
      }
      const found = answer.data.providers.find((entry) => entry.id === id);
      if (!found) return replacePage('/admin/ai-providers');
      setAll(answer.data.providers);
      setProvider(found);
      setFailed(false);
    });
    return () => {
      current = false;
    };
  }, [id, round, replacePage]);

  async function change(body: Record<string, unknown>): Promise<string | null> {
    const answer = await callOrbit('PATCH', `/api/admin/voice-providers/${encodeURIComponent(id)}`, body);
    if (!answer.ok) return answer.error;
    reload();
    return null;
  }

  if (failed) {
    return (
      <div className="grid min-w-0 max-w-[720px] gap-6">
        <PageHeader kind="provider" title="Voice provider" />
        <LoadError label="the voice provider" retry={reload} />
      </div>
    );
  }
  if (!provider) {
    return (
      <div className="grid min-w-0 max-w-[720px] gap-6">
        <PageHeader kind="provider" title="Voice provider" />
        <LoadingRows label="the voice provider" rows={3} />
      </div>
    );
  }

  const isDefault = provider.defaultRecognition || provider.defaultSpeech;
  const company = companyLabel(provider.adapter);
  const own = COMPANY_HOST[provider.adapter];
  // People can add a company's key while any provider of it is on
  const stillOn = all.some((other) => other.id !== id && other.adapter === provider.adapter && other.enabled);
  const jobs: VoiceJob[] = [...(provider.recognition ? (['recognition'] as const) : []), ...(provider.speech ? (['speech'] as const) : [])];

  const used = [
    provider.defaultRecognition && `Universe AI’s default for listening: bots that turn voice on start with ${modelName(startingModel(provider, 'recognition') ?? { id: 'no model', kind: 'recognition' })}. ${bots(provider.bots.recognition)} listen with it.`,
    provider.defaultSpeech &&
      `Universe AI’s default for speaking: bots that turn voice on start with ${provider.defaultVoiceName ?? 'the first voice it lists'} on ${modelName(startingModel(provider, 'speech') ?? { id: 'no model', kind: 'speech' })}. ${bots(provider.bots.speech)} speak with it.`,
  ].filter(Boolean) as string[];

  /** A model list change: the default for a job always keeps a model to start from. */
  async function changeModels(models: VoiceModel[]) {
    setProblem(null);
    for (const [job, isDefaultFor, word] of [
      ['recognition', provider!.defaultRecognition, 'listening'],
      ['speech', provider!.defaultSpeech, 'speaking'],
    ] as const) {
      if (isDefaultFor && !models.some((model) => model.kind === job)) {
        setProblem(`It’s the default for ${word}, so it keeps a ${word} model. Add another before taking this one off.`);
        return;
      }
    }
    setBusy(true);
    const refused = await change({ models });
    setBusy(false);
    if (refused) setProblem(refused);
  }

  /** Said instead of a check: the company's own address can't vouch for a key made for another one. */
  const ownAddressNote = `This provider uses its own address, so ${company} can’t check its key.`;

  async function check() {
    if (provider!.endpoint) {
      setChecked({ ok: 'note', message: ownAddressNote });
      return;
    }
    setChecking(true);
    setChecked(null);
    const answer = await callOrbit('POST', `/api/admin/voice-providers/${encodeURIComponent(id)}/check`);
    setChecking(false);
    setChecked(answer.ok ? { ok: true } : { ok: false, message: answer.error });
  }

  async function replaceKey(key: string): Promise<string | null> {
    if (key === '') return 'Paste the new key first.';
    // A key is asked about before it replaces the saved one, so a typo never takes a working key away. The check goes to the
    // company's own address only, so a provider with its own address would have a key made for that address turned away: it is
    // not asked there.
    const ownAddress = Boolean(provider!.endpoint);
    if (!ownAddress) {
      const asked = await callOrbit('POST', '/api/admin/voice-providers/check', { adapter: provider!.adapter, apiKey: key });
      if (!asked.ok) return asked.error;
    }
    const refused = await change({ apiKey: key });
    if (refused) return refused;
    setEditing(null);
    setChecked(ownAddress ? null : { ok: true });
    addToast({ description: 'Key replaced', variant: 'success', duration: 2500 });
    return null;
  }

  async function remove() {
    setBusy(true);
    setProblem(null);
    const answer = await callOrbit('DELETE', `/api/admin/voice-providers/${encodeURIComponent(id)}`);
    if (!answer.ok) {
      setProblem(answer.error);
      setBusy(false);
      return;
    }
    addToast({ description: `${provider!.name} removed`, variant: 'success', duration: 2500 });
    router.push('/admin/ai-providers');
  }

  return (
    <div className="grid min-w-0 max-w-[720px] gap-6" data-testid="voice-provider">
      <PageHeader
        icon={<ProviderLogo info={logoOf(provider.adapter)} size={30} slot={34} />}
        title={provider.name}
        context={
          <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {doesLine(provider)}
            <EnabledPill enabled={provider.enabled} />
            <DefaultPills provider={provider} />
          </span>
        }
      />
      {!isDefault && (
        <Settings label="On or off">
          <SettingSwitch
            id="enabled"
            label="On"
            hint="Bots and people’s own keys can use it. Off, its bots answer in text."
            checked={provider.enabled}
            disabled={busy}
            onChange={async (next) => {
              setBusy(true);
              setProblem(null);
              const refused = await change({ enabled: next });
              setBusy(false);
              if (refused) setProblem(refused);
            }}
          />
        </Settings>
      )}
      <section className="grid gap-2">
        <Caption>Used by</Caption>
        {used.map((line) => (
          <p key={line} className="text-[15px]">
            {line}
          </p>
        ))}
        {isDefault ? (
          <p className="text-[15px]">It stays on while it’s the default.</p>
        ) : (
          <p className="text-[15px]">{botsOn(provider) > 0 ? `${bots(botsOn(provider))} ${verbFor(provider)} with it because their maker picked it.` : 'No bots use it yet.'}</p>
        )}
      </section>
      <section className="grid gap-2">
        <Caption>Key</Caption>
        {editing === 'key' ? (
          <EditField label="New key" initial="" type="password" placeholder="Paste the new key" hint={provider.endpoint ? `Replaces the saved one. ${company} can’t check a key for this provider’s own address. Stored encrypted.` : `Asks ${company} if it knows the key first, then replaces the saved one. Stored encrypted.`} save={replaceKey} onCancel={() => setEditing(null)} go={provider.endpoint ? 'Replace' : 'Check and replace'} />
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-foreground/[.04] py-1 pl-3 pr-1">
            <span className="min-w-0 flex-1 text-[15px]">{provider.hasKey ? `••••${provider.apiKeyLast4 ?? ''}` : 'No key yet'}</span>
            {provider.hasKey && (
              <Button variant="outline" className="h-11 shrink-0 px-4" disabled={checking} onClick={() => void check()}>
                <ShieldCheck aria-hidden="true" />
                {checking ? 'Checking…' : 'Check key'}
              </Button>
            )}
            <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => setEditing('key')}>
              <RefreshCw aria-hidden="true" />
              {provider.hasKey ? 'Replace' : 'Add a key'}
            </Button>
          </div>
        )}
        {checked?.ok === true && <Answered>{company} knows this key. Checked just now, nothing paid.</Answered>}
        {checked?.ok === false && <Refused>{checked.message}</Refused>}
        {checked?.ok === 'note' && <p className="text-[13px] text-muted-foreground">{checked.message}</p>}
      </section>
      <section className="grid gap-2">
        <Caption>Models</Caption>
        <p className="-mt-1 text-[13px] text-muted-foreground">Bots on Universe AI, and people’s own {company} keys, can use only these.</p>
        <ModelRows models={provider.models} jobs={jobs} onChange={changeModels} disabled={busy} />
      </section>
      <section className="grid gap-2">
        <Caption>Address</Caption>
        {editing === 'address' ? (
          <EditField
            label="Address"
            type="url"
            initial={provider.endpoint ?? ''}
            placeholder={`${provider.speech ? 'https' : 'wss'}://${own}`}
            hint={`Leave empty to use ${company}’s own. Must start with ${provider.speech ? 'https://' : 'https:// or wss://'}.`}
            save={async (value) => {
              const refused = await change({ endpoint: value === '' ? null : value });
              if (!refused) setEditing(null);
              return refused;
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <ValueRow
            action={
              <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => setEditing('address')}>
                Change
              </Button>
            }
          >
            {provider.endpoint ? provider.endpoint : <>{own} <span className="text-muted-foreground">({company}’s own)</span></>}
          </ValueRow>
        )}
      </section>
      <section className="grid gap-2">
        <Caption>Name</Caption>
        {editing === 'name' ? (
          <EditField
            label="Name"
            initial={provider.name}
            save={async (value) => {
              if (value === '') return 'A provider needs a name.';
              const refused = await change({ name: value });
              if (!refused) setEditing(null);
              return refused;
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <ValueRow
            action={
              <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => setEditing('name')}>
                Rename
              </Button>
            }
          >
            {provider.name}
          </ValueRow>
        )}
      </section>
      {problem && !deleting && <Refused>{problem}</Refused>}
      <section className="grid gap-2 border-t border-foreground/10 pt-5">
        <Caption>Danger zone</Caption>
        <Button variant="outline" className="h-11 w-fit border-[#fca5a5]/60 px-5 text-[#fca5a5] hover:text-[#fca5a5]" disabled={isDefault || busy} onClick={() => setDeleting(true)}>
          <Trash2 aria-hidden="true" />
          Delete provider
        </Button>
        {isDefault ? (
          <p className="text-[13px] text-muted-foreground">
            It’s the default for {[provider.defaultRecognition && 'listening', provider.defaultSpeech && 'speaking'].filter(Boolean).join(' and ')}. Make another provider the default first.
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">{botsOn(provider) > 0 ? `Its ${bots(botsOn(provider))} answer in text until their maker picks another voice.` : 'No bot uses it.'}</p>
        )}
      </section>
      <FormSheet open={deleting} onOpenChange={(open) => !open && !busy && setDeleting(false)} title={`Delete ${provider.name}?`}>
        <p className="text-sm text-muted-foreground">
          {botsOn(provider) > 0 ? `Its ${bots(botsOn(provider))} answer in text until their maker picks another voice. ` : ''}
          Its key is deleted with it. {stillOn ? '' : `People can’t add a ${company} key while no ${company} provider is on.`}
        </p>
        {problem && <Refused>{problem}</Refused>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={() => setDeleting(false)}>
            Cancel
          </Button>
          <Button className="h-11 px-5" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </FormSheet>
    </div>
  );
}
