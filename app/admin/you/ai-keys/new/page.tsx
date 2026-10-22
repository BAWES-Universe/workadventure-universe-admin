'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PickCard, Radio } from '@/components/ui/choice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

function KindCard({ info, picked, onPick }: { info: AiKeyKindInfo; picked: boolean; onPick: () => void }) {
  return (
    <div className="grid gap-1.5">
      <PickCard role="radio" picked={picked} onClick={onPick} indicator={<Radio checked={picked} />} title={info.label} description={info.benefit} className="items-start">
        {picked && (
          <ol className="mt-3 grid list-decimal gap-2 border-t border-foreground/10 pt-3 pl-5 text-[13px] font-normal">
            {info.steps.map((step) => (
              <li key={step.text}>
                {step.text}
                {step.code && <code className="mt-1.5 block overflow-x-auto rounded-xl bg-foreground/[.08] px-3 py-2 text-xs">{step.code}</code>}
              </li>
            ))}
          </ol>
        )}
      </PickCard>
      {picked && info.docs && (
        <a href={info.docs} target="_blank" rel="noreferrer noopener" className="flex min-h-11 items-center px-3.5 text-[13px] underline underline-offset-2">
          Read about {info.label}
        </a>
      )}
    </div>
  );
}

/**
 * Add a key (#374): pick a type, give its address and key, load its models (which also proves it answers) and pick
 * one. Add key stays off until the models loaded. The key is sent once and never shown again.
 */
export default function AddAiKeyPage() {
  const router = useRouter();
  const { addToast } = useToast();
  const [kind, setKind] = useState<AiKeyKind | null>(null);
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

  const info = kindInfo(kind);
  const name = typedName ?? (info ? `My ${info.label}` : '');
  // The picked type stays on screen whatever is typed in the search
  const needle = find.trim().toLowerCase();
  // The listed-by-models.dev line is the same on every one of the "more" providers, so only their name is searched
  const matches = (entry: AiKeyKindInfo) => entry.kind === kind || !needle || (entry.tier === 'more' ? entry.label : `${entry.label} ${entry.benefit}`).toLowerCase().includes(needle);
  const shown = AI_KEY_KINDS.filter((entry) => entry.tier !== 'hidden' && (entry.tier === 'named' ? matches(entry) : entry.kind === kind || (needle !== '' ? matches(entry) : showMore)));
  const ownComputer = shown.filter((entry) => entry.group === 'own-computer');
  const hosted = shown.filter((entry) => entry.group === 'hosted' && entry.tier === 'named');
  const more = shown.filter((entry) => entry.tier === 'more');
  const moreCount = AI_KEY_KINDS.filter((entry) => entry.tier === 'more').length;

  function pickKind(next: AiKeyKind) {
    // Clicking the type that is already picked (or inside its open card) changes nothing.
    if (next === kind) return;
    setKind(next);
    setRegion(null);
    changed();
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

  return (
    <div className="grid gap-6" data-testid="add-ai-key-page">
      <PageHeader icon={<KeyRound size={30} aria-hidden="true" />} title="Add a key">
        <p className="max-w-[60ch] text-[15px] text-muted-foreground">Your own AI, hosted or on your own computer. Only bots you make can use it.</p>
      </PageHeader>

      <form
        className="grid gap-6 rounded-3xl border border-foreground/10 bg-foreground/[.03] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <fieldset className="grid gap-4">
          <legend className="mb-1 text-[15px] font-semibold">Type</legend>
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
          <div role="radiogroup" aria-label="Type" className="grid gap-4">
            {shown.length === 0 && <p className={FIELD_HINT}>No provider matches that. “Any OpenAI-compatible server” takes any address that speaks the OpenAI format.</p>}
            {ownComputer.length > 0 && <div className="grid gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">On your own computer</h2>
              {ownComputer.map((entry) => (
                <KindCard key={entry.kind} info={entry} picked={kind === entry.kind} onPick={() => pickKind(entry.kind)} />
              ))}
            </div>}
            {hosted.length > 0 && <div className="grid gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Hosted, with an API key</h2>
              {hosted.map((entry) => (
                <KindCard key={entry.kind} info={entry} picked={kind === entry.kind} onPick={() => pickKind(entry.kind)} />
              ))}
            </div>}
            {more.length > 0 && <div className="grid gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">More providers</h2>
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
        </fieldset>

        {info?.regions && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[15px] font-semibold">Region</legend>
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
          </fieldset>
        )}

        {info && info.address !== 'none' && (
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
              {info.group === 'own-computer' && ' A quick tunnel’s address changes each time cloudflared restarts; a named Cloudflare tunnel keeps one.'}
            </p>
          </div>
        )}

        {info && (
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
              {info.group === 'own-computer' && ' A tunnel with no key can be used by anyone who finds its address, so set a key on your server if it allows one.'}
            </p>
          </div>
        )}

        {info && (
          <div className="grid gap-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Model</span>
              <Button type="button" variant="outline" className="h-11 px-4" disabled={!canLoad || models.status === 'loading'} onClick={() => void loadModels()}>
                <Download aria-hidden="true" />
                {models.status === 'loading' ? 'Loading…' : 'Load models'}
              </Button>
            </div>
            {models.status === 'none' && <p className={FIELD_HINT}>Load models to check that it answers, then pick one.</p>}
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
            {models.status === 'failed' && (
              <p role="alert" className="text-sm text-[#fca5a5]">
                {models.message}
              </p>
            )}
            {models.status === 'ready' && (
              <>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Check size={16} aria-hidden="true" className="text-[#4ade80]" />
                  It answered. {info.label} has {models.models.length} {models.models.length === 1 ? 'model' : 'models'}.
                </p>
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
          </div>
        )}

        {info && (
          <div className="grid gap-1.5">
            <Label htmlFor="ai-key-name">Name</Label>
            <Input id="ai-key-name" maxLength={60} value={name} onChange={(event) => setTypedName(event.target.value)} className="h-11 rounded-xl" />
            <p className={FIELD_HINT}>Shown here, and in Runs on for the bots that use it.</p>
          </div>
        )}

        {failure && (
          <p role="alert" className="text-sm text-[#fca5a5]">
            {failure}
          </p>
        )}

        <div className="grid gap-2">
          <Button type="submit" className="h-11" disabled={!info || !model || model.trim() === '' || name.trim() === '' || saving}>
            {saving ? 'Adding…' : 'Add key'}
          </Button>
          <Button type="button" variant="outline" className="h-11" disabled={saving} onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
