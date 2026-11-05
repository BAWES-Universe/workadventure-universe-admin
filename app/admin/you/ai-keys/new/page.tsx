'use client';

import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PickCard, Radio } from '@/components/ui/choice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProviderLogo } from '../../../components/ds/provider-logo';
import { ModelPicker, makerOf } from '../../../components/ds/model-picker';
import { useToast } from '@/components/ui/toast';
import { authenticatedFetch } from '@/lib/client-auth';
import { AI_KEY_KINDS, kindInfo, type AiKeyKind, type AiKeyKindInfo } from '@/lib/ai-key-kinds';
import { PageHeader } from '../../../components/ds';
import { AiKeyFailure, aiKeyError, aiKeyFailureText } from '../../../hooks/use-ai-keys';
import { useVoiceCompanies, voiceCompanyKind } from '../../../hooks/use-voice-keys';
import type { VoiceModel } from '@/lib/voice-providers';
import { openLinkInGame, useLinksOpeningInGame } from '../../../components/orbit-bridge';

type Models = { status: 'none' } | { status: 'loading' } | { status: 'ready'; models: string[]; facts: Record<string, { tools?: boolean; vision?: boolean }> } | { status: 'voice'; models: VoiceModel[] } | { status: 'failed'; message: string } | { status: 'typed' };

const FIELD_HINT = 'text-[13px] text-muted-foreground';
/** More providers than this and a search box appears. */
const SEARCH_FROM = 8;

/** One setup step: its words, and the command to copy when it has one. */
function SetupStep({ step }: { step: AiKeyKindInfo['steps'][number] }) {
  return (
    <>
      {step.text}
      {step.code && <code className="mt-1.5 block overflow-x-auto rounded-xl bg-foreground/[.08] px-3 py-2 text-xs">{step.code}</code>}
    </>
  );
}

function KindCard({ info, picked, onPick }: { info: AiKeyKindInfo; picked: boolean; onPick: () => void }) {
  return (
    <PickCard role="radio" picked={picked} onClick={onPick} indicator={<ProviderLogo info={info} />} trailing={<Radio checked={picked} className="mt-0.5 self-start" />} title={info.label} description={info.benefit} className="items-start" />
  );
}

/** One numbered part of step 2: a small number, its title, then what it asks for. */
function Part({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="flex items-center gap-2.5 text-[15px] font-semibold">
        <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-content-center rounded-full border border-foreground/20 text-xs font-bold">{n}</span>
        {title}
      </h2>
      <div className="grid gap-3 pl-[34px]">{children}</div>
    </section>
  );
}

/**
 * How to get a key (or start a server), with "Read about" inside the same card. Inside the game, a plain click opens the
 * page in the game's window when the game says it can show it (#571), and that link has no new-tab icon. Every other
 * page, and a Ctrl, Cmd, Shift or middle click, opens a new tab.
 */
function SetupCard({ info }: { info: AiKeyKindInfo }) {
  const opensHere = useLinksOpeningInGame(info.docs ? [info.docs] : []);
  const here = info.docs ? opensHere.has(info.docs) : false;
  return (
    <div className="grid gap-1 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 pt-3 text-[13px]" data-testid="setup-card">
      {info.steps.length === 1 ? (
        <p className="pb-1"><SetupStep step={info.steps[0]} /></p>
      ) : (
        <ol className="grid list-decimal gap-2 pb-1 pl-5">
          {info.steps.map((step) => (
            <li key={step.text}>
              <SetupStep step={step} />
            </li>
          ))}
        </ol>
      )}
      {info.docs ? (
        <a
          href={info.docs}
          target="_blank"
          rel="noreferrer noopener"
          className="-mx-3.5 flex min-h-11 items-center gap-2 border-t border-foreground/10 px-3.5 font-semibold"
          data-testid="read-about"
          onClick={(event) => {
            if (!here || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            if (openLinkInGame(info.docs!)) event.preventDefault();
          }}
        >
          Read about {info.label}
          {!here && <ExternalLink size={15} aria-hidden="true" className="text-muted-foreground" />}
        </a>
      ) : (
        <span className="pb-2" />
      )}
    </div>
  );
}

/**
 * Add a key (#374, two steps since #575): step 1 picks a provider; step 2 sets it up in numbered parts: how to get a
 * key (Read about inside that card), its address and key, load its models (which also proves it answers) and see
 * them, then a name. No model is picked here: each bot picks its own, and a lend can limit them. A provider with no
 * model list has its one model typed. Add key stays off until the models loaded. The key is sent once and never shown again.
 */
export default function AddAiKeyPage() {
  const router = useRouter();
  const { addToast } = useToast();
  const [kind, setKind] = useState<AiKeyKind | null>(null);
  // A speech company for voice (#749), picked instead of a provider: its adapter
  const [voiceAdapter, setVoiceAdapter] = useState<string | null>(null);
  const companies = useVoiceCompanies();
  const voiceKinds = (companies.result.status === 'ready' ? companies.result.items : []).map(voiceCompanyKind);
  // Two steps on one page: pick a provider, then set it up. Change goes back to the list with the pick kept.
  const [step, setStep] = useState<'pick' | 'setup'>('pick');
  const [region, setRegion] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [address, setAddress] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Models>({ status: 'none' });
  const [model, setModel] = useState<string | null>(null);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Only the newest model load may answer: a slow one for a type, address or key since changed is dropped
  const latestLoad = useRef(0);
  // The heading of the step on screen: moving to a step puts keyboard focus there, never on a card that went away
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const focusStep = useRef(false);
  useEffect(() => {
    if (!focusStep.current) return;
    focusStep.current = false;
    stepHeading.current?.focus();
  }, [step]);

  const voiceInfo = voiceKinds.find((entry) => entry.kind === voiceAdapter) ?? null;
  const info = voiceInfo ?? kindInfo(kind);
  const name = typedName ?? (info ? `My ${info.label}` : '');
  // The picked type stays on screen whatever is typed in the search
  const needle = find.trim().toLowerCase();
  const matches = (entry: AiKeyKindInfo) => entry.kind === (voiceAdapter ?? kind) || !needle || `${entry.label} ${entry.benefit}`.toLowerCase().includes(needle);
  const shown = AI_KEY_KINDS.filter((entry) => entry.tier !== 'hidden' && (entry.tier === 'named' ? matches(entry) : entry.kind === kind || (needle !== '' ? matches(entry) : showMore)));
  const ownComputer = shown.filter((entry) => entry.group === 'own-computer');
  const hosted = shown.filter((entry) => entry.group === 'hosted' && entry.tier === 'named');
  const voice = voiceKinds.filter(matches);
  const more = shown.filter((entry) => entry.tier === 'more');
  const moreCount = AI_KEY_KINDS.filter((entry) => entry.tier === 'more').length;

  function pickKind(next: AiKeyKind) {
    // Picking the type that is already picked keeps what was typed for it
    if (next !== kind || voiceAdapter !== null) {
      setKind(next);
      setVoiceAdapter(null);
      setRegion(null);
      // A key or address typed for one provider is never sent to another
      setAddress('');
      setApiKey('');
      changed();
    }
    goToStep('setup');
  }

  /** Picks a speech company for voice: its key is checked with the company and added as a voice key. */
  function pickVoice(adapter: string) {
    if (adapter !== voiceAdapter) {
      setKind(null);
      setVoiceAdapter(adapter);
      setRegion(null);
      setAddress('');
      setApiKey('');
      changed();
    }
    goToStep('setup');
  }

  /** Picking and Change move between the steps the same way: back to the top, with focus on the step's heading. */
  function goToStep(next: 'pick' | 'setup') {
    focusStep.current = true;
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  // Anything that decides what the provider would answer clears the loaded list: a model picked for another key
  // or address is never kept.
  function changed() {
    latestLoad.current += 1;
    setModels({ status: 'none' });
    setModel(null);
    setFailure(null);
  }

  const canLoad =
    !!info &&
    (!info.regions || region !== null) &&
    (info.address !== 'required' || address.trim() !== '') &&
    (info.apiKey !== 'required' || apiKey.trim() !== '');

  async function loadModels() {
    if (!info) return;
    const mine = ++latestLoad.current;
    setModels({ status: 'loading' });
    setModel(null);
    setFailure(null);
    try {
      if (voiceInfo) {
        // One free call to the company with the key; the models are the ones Universe's own providers for it list
        const response = await authenticatedFetch('/api/me/voice-keys/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adapter: voiceInfo.kind, apiKey }),
        });
        const data: { ok?: boolean; models?: VoiceModel[]; error?: string } = await response.json().catch(() => ({}));
        if (mine !== latestLoad.current) return;
        if (response.ok && data.ok && Array.isArray(data.models)) setModels({ status: 'voice', models: data.models });
        else setModels({ status: 'failed', message: response.status === 401 ? 'Sign in again, then try again.' : (data.error ?? 'That didn’t work. Try again.') });
        return;
      }
      const response = await authenticatedFetch('/api/me/ai-keys/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: info.kind, address, ...(region ? { region } : {}), apiKey }),
      });
      const data: { ok?: boolean; models?: string[]; facts?: Record<string, { tools?: boolean; vision?: boolean }>; message?: string; noList?: boolean } = await response.json().catch(() => ({}));
      if (mine !== latestLoad.current) return;
      if (data.ok && Array.isArray(data.models)) {
        // Nothing is picked here: each bot picks its own model from the key's list
        setModels({ status: 'ready', models: data.models, facts: data.facts ?? {} });
      } else if (data.noList) {
        // This provider has no model list: the model is typed, and Add key proves it with one tiny reply
        setModels({ status: 'typed' });
      } else {
        setModels({ status: 'failed', message: data.message ?? 'That didn’t work. Try again.' });
      }
    } catch {
      if (mine !== latestLoad.current) return;
      setModels({ status: 'failed', message: 'We couldn’t reach Universe. Check your connection and try again.' });
    }
  }

  // A listed provider needs at least one model for the key's check; a provider with no list needs its model typed
  const canAdd = models.status === 'ready' || models.status === 'voice' ? models.models.length > 0 : models.status === 'typed' && !!model && model.trim() !== '';

  async function add() {
    if (!info || !canAdd) return;
    setSaving(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(models.status === 'voice' ? '/api/me/voice-keys' : '/api/me/ai-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:
          models.status === 'voice'
            ? JSON.stringify({
                adapter: info.kind,
                name,
                apiKey,
                recognition: models.models.some((entry) => entry.kind === 'recognition'),
                speech: models.models.some((entry) => entry.kind === 'speech'),
                models: models.models,
              })
            : JSON.stringify({ kind: info.kind, address, ...(region ? { region } : {}), apiKey, ...(model ? { model: model.trim() } : {}), name }),
      });
      if (!response.ok) {
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw new AiKeyFailure(aiKeyError(response.status, data.error));
      }
      addToast({ description: `${name} added`, variant: 'success', duration: 2500 });
      router.push('/admin/you/ai-keys');
    } catch (error) {
      setFailure(aiKeyFailureText(error));
      setSaving(false);
    }
  }

  const own = info?.group === 'own-computer';
  const makerCount = models.status === 'ready' ? new Set(models.models.map((id) => makerOf(id).key)).size : 0;
  const loaded = models.status === 'ready' || models.status === 'typed' || models.status === 'voice';
  let part = 1;

  return (
    <div className="grid gap-6" data-testid="add-ai-key-page">
      <PageHeader icon={<KeyRound size={30} aria-hidden="true" />} title="Add a key">
        <p className="max-w-[60ch] text-[15px] text-muted-foreground">Your own AI, hosted or on your own computer. Only you can put a bot on it.</p>
      </PageHeader>

      {step === 'pick' || !info ? (
        <div className="grid w-full max-w-[720px] gap-4 rounded-3xl border border-foreground/10 bg-foreground/[.03] p-4" data-testid="step-pick">
          <div className="grid gap-0.5">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Step 1 of 2</span>
            <h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">Pick a provider</h2>
          </div>
          {AI_KEY_KINDS.length > SEARCH_FROM && (
            <Input
              type="search"
              aria-label="Search providers"
              placeholder="Search providers"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              className="h-11 rounded-xl"
            />
          )}
          <div role="radiogroup" aria-label="Provider" className="grid gap-4">
            {shown.length === 0 && voice.length === 0 && <p className={FIELD_HINT}>No provider matches that. “Any OpenAI-compatible server” takes any address that speaks the OpenAI format.</p>}
            {ownComputer.length > 0 && <div className="grid gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">On your own computer</h3>
              {ownComputer.map((entry) => (
                <KindCard key={entry.kind} info={entry} picked={kind === entry.kind} onPick={() => pickKind(entry.kind)} />
              ))}
            </div>}
            {hosted.length > 0 && <div className="grid gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Hosted, with an API key</h3>
              {hosted.map((entry) => (
                <KindCard key={entry.kind} info={entry} picked={kind === entry.kind} onPick={() => pickKind(entry.kind)} />
              ))}
            </div>}
            {voice.length > 0 && <div className="grid gap-2" data-testid="kinds-voice">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">For voice, with an API key</h3>
              {voice.map((entry) => (
                <KindCard key={entry.kind} info={entry} picked={voiceAdapter === entry.kind} onPick={() => pickVoice(entry.kind)} />
              ))}
            </div>}
            {more.length > 0 && <div className="grid gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">More providers</h3>
              {more.map((entry) => (
                <KindCard key={entry.kind} info={entry} picked={kind === entry.kind} onPick={() => pickKind(entry.kind)} />
              ))}
            </div>}
            {needle === '' && (
              <Button type="button" variant="outline" className="h-11 w-fit px-5" aria-expanded={showMore} onClick={() => setShowMore((open) => !open)}>
                {showMore ? 'Show fewer providers' : `More providers (${moreCount})`}
              </Button>
            )}
          </div>
          <Button type="button" variant="outline" className="h-11" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      ) : (
        <form
          className="grid w-full max-w-[720px] gap-6 rounded-3xl border border-foreground/10 bg-foreground/[.03] p-4"
          data-testid="step-setup"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="grid gap-3">
            <div className="grid gap-0.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Step 2 of 2</span>
              <h2 ref={stepHeading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">Set up {info.label}</h2>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)] px-3.5 py-2.5" data-testid="picked-provider">
              <ProviderLogo info={info} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{info.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{info.benefit}</span>
              </span>
              <Button type="button" variant="outline" className="h-11 shrink-0 px-4" disabled={saving} onClick={() => goToStep('pick')}>
                Change
              </Button>
            </div>
          </div>

          <Part n={part++} title={own ? 'Start your server' : `Get your ${info.label} key`}>
            <SetupCard info={info} />
          </Part>

          {info.regions && (
            <Part n={part++} title="Pick the region">
              <div role="radiogroup" aria-label="Region" className="grid gap-2 sm:grid-cols-2">
                {info.regions.map((entry) => (
                  <PickCard
                    key={entry.id}
                    role="radio"
                    picked={region === entry.id}
                    onClick={() => { if (entry.id === region) return; setRegion(entry.id); changed(); }}
                    indicator={<Radio checked={region === entry.id} />}
                    title={entry.label}
                    description={new URL(entry.base).host}
                  />
                ))}
              </div>
              <p className={FIELD_HINT}>A key only works in the region it was made in.</p>
            </Part>
          )}

          <Part n={part++} title={own ? 'Paste its address' : 'Paste your key'}>
            {info.address !== 'none' && (
              <div className="grid gap-1.5">
                <Label htmlFor="ai-key-address">{info.address === 'optional' ? 'Your own NIM address (optional)' : 'Address'}</Label>
                <Input
                  id="ai-key-address"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://lm.example.com"
                  value={address}
                  onChange={(event) => { setAddress(event.target.value); changed(); }}
                  className="h-11 rounded-xl"
                />
                <p className={FIELD_HINT}>
                  Must start with https:// and be reachable from the internet. Private network addresses are refused.
                  {own && ' A quick tunnel’s address changes each time cloudflared restarts; a named Cloudflare tunnel keeps one.'}
                </p>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="ai-key-secret">{info.apiKey === 'optional' ? 'API key, if your server asks for one' : 'API key'}</Label>
              <Input
                id="ai-key-secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={info.apiKey === 'optional' ? 'Leave empty if none' : 'Paste your key'}
                value={apiKey}
                onChange={(event) => { setApiKey(event.target.value); changed(); }}
                className="h-11 rounded-xl"
              />
              <p className={FIELD_HINT}>
                Stored encrypted. Nobody sees it again, not even you.
                {own && ' A tunnel with no key can be used by anyone who finds its address, so set a key on your server if it allows one.'}
              </p>
            </div>
            <div className="grid gap-2" aria-live="polite">
              <Button type="button" variant="outline" className="h-11" disabled={!canLoad || models.status === 'loading'} onClick={() => void loadModels()}>
                <Download aria-hidden="true" />
                {models.status === 'loading' ? 'Loading…' : 'Load models'}
              </Button>
              {models.status === 'none' && <p className={FIELD_HINT}>Loads {info.label}’s models, which also checks that it answers.</p>}
              {models.status === 'failed' && (
                <p role="alert" className="text-sm text-[#fca5a5]">
                  {models.message}
                </p>
              )}
              {(models.status === 'ready' || models.status === 'voice') && (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Check size={16} aria-hidden="true" className="text-[#4ade80]" />
                  It answered. {info.label} has {models.models.length} {models.models.length === 1 ? 'model' : 'models'}{makerCount > 1 ? ` from ${makerCount} makers` : ''}.
                </p>
              )}
            </div>
          </Part>

          <Part n={part++} title={models.status === 'typed' ? 'Name its model' : 'Its models'}>
            {!loaded && <p className={FIELD_HINT}>{info.label}’s models show here once they load.</p>}
            {models.status === 'typed' && (
              <div className="grid gap-1.5">
                <Label htmlFor="ai-key-model-name">Model name</Label>
                <Input
                  id="ai-key-model-name"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={255}
                  value={model ?? ''}
                  onChange={(event) => setModel(event.target.value.trim() === '' ? null : event.target.value)}
                  className="h-11 rounded-xl"
                />
                <p className={FIELD_HINT}>
                  {info.label} doesn’t share a list of its models. Type the name as {info.label} writes it. Add key checks it with one tiny reply.
                </p>
              </div>
            )}
            {models.status === 'voice' && (
              <>
                <p className={FIELD_HINT}>Nothing to pick here. Each bot picks one of these on its own page. When you lend the key, you can limit which ones bots there may use.</p>
                {(['recognition', 'speech'] as const).map((job) => {
                  const list = models.models.filter((entry) => entry.kind === job);
                  return (
                    list.length > 0 && (
                      <div key={job} className="grid gap-1.5" data-testid={`voice-models-${job}`}>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{job === 'recognition' ? 'Listens' : 'Speaks'}</h3>
                        <ul className="m-0 grid list-none gap-0 rounded-2xl border border-foreground/10 p-0">
                          {list.map((entry) => (
                            <li key={entry.id} className="flex min-h-11 items-center gap-2 border-t border-foreground/10 px-3 text-[15px] first:border-t-0" data-testid="model-row">
                              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{entry.label || entry.id}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  );
                })}
              </>
            )}
            {models.status === 'ready' && (
              <>
                <p className={FIELD_HINT}>Nothing to pick here. Each bot picks one of these on its own page. When you lend the key, you can limit which ones bots there may use.</p>
                <ModelPicker models={models.models} facts={models.facts} mode="browse" label={`${info.label} models`} />
              </>
            )}
          </Part>

          <Part n={part++} title="Name it">
            <div className="grid gap-1.5">
              <Label htmlFor="ai-key-name" className="sr-only">Name</Label>
              <Input id="ai-key-name" maxLength={60} value={name} onChange={(event) => setTypedName(event.target.value)} className="h-11 rounded-xl" />
              <p className={FIELD_HINT}>{voiceInfo ? 'Shown here, and under Voice for the bots that use it.' : 'Shown here, and in Runs on for the bots that use it.'}</p>
            </div>
          </Part>

          {failure && (
            <p role="alert" className="text-sm text-[#fca5a5]">
              {failure}
            </p>
          )}

          <div className="grid gap-2">
            <Button type="submit" className="h-11" disabled={!canAdd || name.trim() === '' || saving}>
              {saving ? 'Adding…' : 'Add key'}
            </Button>
            <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => router.back()}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
