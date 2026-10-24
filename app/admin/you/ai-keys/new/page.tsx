'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PickCard, Radio } from '@/components/ui/choice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProviderLogo } from '../../../components/ds/provider-logo';
import { useToast } from '@/components/ui/toast';
import { authenticatedFetch } from '@/lib/client-auth';
import { AI_KEY_KINDS, kindInfo, type AiKeyKind, type AiKeyKindInfo } from '@/lib/ai-key-kinds';
import { PageHeader } from '../../../components/ds';
import { AiKeyFailure, aiKeyError, aiKeyFailureText } from '../../../hooks/use-ai-keys';

type Models = { status: 'none' } | { status: 'loading' } | { status: 'ready'; models: string[]; facts: Record<string, { tools?: boolean; vision?: boolean }> } | { status: 'failed'; message: string } | { status: 'typed' };

/** Said when a provider's own list says the model cannot call tools (it does not say, for most models, and then nothing is said). */
const NO_TOOLS = 'This model has no Tools. Bots on it can still chat.';

const FIELD_HINT = 'text-[13px] text-muted-foreground';
/** More models than this and a search box appears; only this many are shown at once. */
const SEARCH_FROM = 8;
const SHOWN = 30;

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

/** How to get a key (or start a server), with "Read about" inside the same card. */
function SetupCard({ info }: { info: AiKeyKindInfo }) {
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
        <a href={info.docs} target="_blank" rel="noreferrer noopener" className="-mx-3.5 flex min-h-11 items-center gap-2 border-t border-foreground/10 px-3.5 font-semibold" data-testid="read-about">
          Read about {info.label}
          <ExternalLink size={15} aria-hidden="true" className="text-muted-foreground" />
        </a>
      ) : (
        <span className="pb-2" />
      )}
    </div>
  );
}

/**
 * Add a key (#374, two steps since #575): step 1 picks a provider; step 2 sets it up in numbered parts: how to get a
 * key (Read about inside that card), its address and key, load its models (which also proves it answers) and pick
 * one, then a name. Add key stays off until the models loaded. The key is sent once and never shown again.
 */
export default function AddAiKeyPage() {
  const router = useRouter();
  const { addToast } = useToast();
  const [kind, setKind] = useState<AiKeyKind | null>(null);
  // Two steps on one page: pick a provider, then set it up. Change goes back to the list with the pick kept.
  const [step, setStep] = useState<'pick' | 'setup'>('pick');
  const [region, setRegion] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [address, setAddress] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Models>({ status: 'none' });
  const [model, setModel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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

  const info = kindInfo(kind);
  const name = typedName ?? (info ? `My ${info.label}` : '');
  // The picked type stays on screen whatever is typed in the search
  const needle = find.trim().toLowerCase();
  const matches = (entry: AiKeyKindInfo) => entry.kind === kind || !needle || `${entry.label} ${entry.benefit}`.toLowerCase().includes(needle);
  const shown = AI_KEY_KINDS.filter((entry) => entry.tier !== 'hidden' && (entry.tier === 'named' ? matches(entry) : entry.kind === kind || (needle !== '' ? matches(entry) : showMore)));
  const ownComputer = shown.filter((entry) => entry.group === 'own-computer');
  const hosted = shown.filter((entry) => entry.group === 'hosted' && entry.tier === 'named');
  const more = shown.filter((entry) => entry.tier === 'more');
  const moreCount = AI_KEY_KINDS.filter((entry) => entry.tier === 'more').length;

  function pickKind(next: AiKeyKind) {
    // Picking the type that is already picked keeps what was typed for it
    if (next !== kind) {
      setKind(next);
      setRegion(null);
      // A key or address typed for one provider is never sent to another
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
    setSearch('');
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
      const response = await authenticatedFetch('/api/me/ai-keys/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: info.kind, address, ...(region ? { region } : {}), apiKey }),
      });
      const data: { ok?: boolean; models?: string[]; facts?: Record<string, { tools?: boolean; vision?: boolean }>; message?: string; noList?: boolean } = await response.json().catch(() => ({}));
      if (mine !== latestLoad.current) return;
      if (data.ok && Array.isArray(data.models)) {
        setModels({ status: 'ready', models: data.models, facts: data.facts ?? {} });
        // The one model there is, is the one picked; otherwise the one this provider suggests, when it lists it.
        if (data.models.length === 1) setModel(data.models[0]);
        else if (info.suggestedModel && data.models.includes(info.suggestedModel)) setModel(info.suggestedModel);
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

  async function add() {
    if (!info || !model) return;
    setSaving(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch('/api/me/ai-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: info.kind, address, ...(region ? { region } : {}), apiKey, model: model.trim(), name }),
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

  const visible = useMemo(() => {
    if (models.status !== 'ready') return [];
    const needle = search.trim().toLowerCase();
    return models.models.filter((id) => !needle || id.toLowerCase().includes(needle)).slice(0, SHOWN);
  }, [models, search]);

  const own = info?.group === 'own-computer';
  const loaded = models.status === 'ready' || models.status === 'typed';
  let part = 1;

  return (
    <div className="grid gap-6" data-testid="add-ai-key-page">
      <PageHeader icon={<KeyRound size={30} aria-hidden="true" />} title="Add a key">
        <p className="max-w-[60ch] text-[15px] text-muted-foreground">Your own AI, hosted or on your own computer. Only bots you make can use it.</p>
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
            {shown.length === 0 && <p className={FIELD_HINT}>No provider matches that. “Any OpenAI-compatible server” takes any address that speaks the OpenAI format.</p>}
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
              {models.status === 'ready' && (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Check size={16} aria-hidden="true" className="text-[#4ade80]" />
                  It answered. {info.label} has {models.models.length} {models.models.length === 1 ? 'model' : 'models'}.
                </p>
              )}
            </div>
          </Part>

          <Part n={part++} title="Pick a model">
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
            {models.status === 'ready' && (
              <>
                {models.models.length > SEARCH_FROM && (
                  <Input
                    type="search"
                    aria-label="Search models"
                    placeholder="Search models"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="h-11 rounded-xl"
                  />
                )}
                <div role="radiogroup" aria-label="Model" className="grid gap-2">
                  {visible.map((id) => (
                    <PickCard key={id} role="radio" picked={model === id} onClick={() => setModel(id)} indicator={<Radio checked={model === id} />} title={id} description={models.facts[id]?.vision ? 'Vision' : undefined} className="[&_span.block]:break-all" />
                  ))}
                  {visible.length === 0 && <p className={FIELD_HINT}>No model matches that.</p>}
                </div>
                {model && models.facts[model]?.tools === false && (
                  <p className="text-sm text-[#F5C451]" data-testid="no-tools-warning">
                    {NO_TOOLS}
                  </p>
                )}
              </>
            )}
          </Part>

          <Part n={part++} title="Name it">
            <div className="grid gap-1.5">
              <Label htmlFor="ai-key-name" className="sr-only">Name</Label>
              <Input id="ai-key-name" maxLength={60} value={name} onChange={(event) => setTypedName(event.target.value)} className="h-11 rounded-xl" />
              <p className={FIELD_HINT}>Shown here, and in Runs on for the bots that use it.</p>
            </div>
          </Part>

          {failure && (
            <p role="alert" className="text-sm text-[#fca5a5]">
              {failure}
            </p>
          )}

          <div className="grid gap-2">
            <Button type="submit" className="h-11" disabled={!model || model.trim() === '' || name.trim() === '' || saving}>
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
