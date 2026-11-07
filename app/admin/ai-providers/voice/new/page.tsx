'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PickCard, Radio } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { VOICE_KEY_COMPANIES, companyHost, joinKey, voiceDoesLine, type VoiceKeyCompanyInfo, type VoiceKeyCompanyModel } from '@/lib/voice-key-companies';
import type { VoiceModel } from '@/lib/voice-providers';
import { PageHeader } from '../../../components/ds';
import { ProviderLogo } from '../../../components/ds/provider-logo';
import { VoiceModelPicker } from '../../../components/ds/voice-model-picker';
import { lendModelId } from '@/lib/voice-lend-model';
import { Answered, COMPANY_JOBS, FIELD_HINT, JOBS, ModelRows, Refused, callOrbit, type VoiceJob } from '../voice-shared';

/** One numbered part of step 2, as Add a key has them. */
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

/** The company's own line with what it does in Universe filled in: "Listens and speaks. Uses your account at …" */
const benefitOf = (info: VoiceKeyCompanyInfo) => info.benefit.replace('{does}', voiceDoesLine(info.does));
/** The models a company's key starts with for one job. */
const startingModels = (info: VoiceKeyCompanyInfo, job: VoiceJob): VoiceKeyCompanyModel[] => (info.jobs[job]?.models ?? []).map((model) => ({ ...model, kind: job }));

/** `listed`: the models the company lists for its job, to tick (null: it has no list, or it couldn't be read, so they are typed). */
type Listed = VoiceModel & { note?: string };
type Check = { status: 'none' } | { status: 'checking' } | { status: 'ok'; listed: Listed[] | null } | { status: 'refused'; message: string };

/**
 * New voice provider (#792): one company Universe AI can listen or speak with, on Universe's own key. Two steps like Add a key:
 * pick a company, then set it up (get the key, paste and check it for free, tick the models the company lists or type them when it
 * has no list, name it). Add provider stays off until
 * the company has accepted the key and one model is listed.
 */
export default function NewVoiceProviderPage() {
  const router = useRouter();
  const { addToast } = useToast();
  const [adapter, setAdapter] = useState<string | null>(null);
  // The job this provider is set up for: a company that listens and speaks is picked under one of them
  const [job, setJob] = useState<VoiceJob>('speech');
  const [apiKey, setApiKey] = useState('');
  // A company whose keys are made per region (AWS, Azure AI Speech) is checked and spoken with in the region picked here
  const [region, setRegion] = useState<string | null>(null);
  // The first part of a key in two parts (AWS's access key ID), shown as typed
  const [keyId, setKeyId] = useState('');
  const [check, setCheck] = useState<Check>({ status: 'none' });
  const [models, setModels] = useState<VoiceModel[]>([]);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [showAddress, setShowAddress] = useState(false);
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Only the newest check may answer: a slow one for a key since changed is dropped
  const latest = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const info = VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter && entry.jobs[job]) ?? null;
  const known = info ? startingModels(info, job) : [];
  const modelList = info?.jobs[job]?.modelList;
  const name = typedName ?? info?.label ?? '';
  const account = info?.account;
  // The key as it is checked and kept: AWS's is the access key ID, a colon, then the secret
  const fullKey = account?.keyId ? joinKey(keyId, apiKey) : apiKey.trim();
  const keyTyped = apiKey.trim() !== '' && (!account?.keyId || keyId.trim() !== '');
  const regionPicked = !account?.regions || region !== null;
  const wssAllowed = job === 'recognition';

  function pick(next: string, nextJob: VoiceJob) {
    if (next !== adapter || nextJob !== job) {
      latest.current += 1;
      setAdapter(next);
      setJob(nextJob);
      // A key typed for one company is never sent to another
      setApiKey('');
      setKeyId('');
      setRegion(null);
      setCheck({ status: 'none' });
      setModels([]);
      setTypedName(null);
      setAddress('');
      setFailure(null);
    }
    window.scrollTo({ top: 0 });
    setTimeout(() => heading.current?.focus(), 0);
  }

  async function checkKey() {
    if (!info) return;
    const mine = ++latest.current;
    setCheck({ status: 'checking' });
    const answer = await callOrbit('POST', '/api/admin/voice-providers/check', { adapter: info.adapter, apiKey: fullKey, job, ...(account?.regions && region ? { region } : {}) });
    if (mine !== latest.current) return;
    if (!answer.ok) {
      setCheck({ status: 'refused', message: answer.error });
      return;
    }
    const found = (answer.data as { models?: unknown } | null)?.models;
    const listed = Array.isArray(found) && found.length > 0 ? (found as Listed[]) : null;
    setCheck({ status: 'ok', listed });
    // Like Pipecat's services, a working model is ticked from the start: the one Universe starts this company's keys on. Nothing
    // picked by hand is replaced.
    const start = listed ? known[0] : undefined;
    if (start) setModels((now) => (now.length > 0 ? now : [{ id: start.id, label: start.label, kind: start.kind }]));
  }

  const addressProblem =
    address.trim() === '' ? null : /^https:\/\//i.test(address.trim()) || (wssAllowed && /^wss:\/\//i.test(address.trim())) ? null : `The address must start with ${wssAllowed ? 'https:// or wss://' : 'https://'}.`;
  // The check asks the company's own address only. A key that is valid only at an address typed under Its own address can be turned away
  // there, so with an address typed a turned-away key may still be added; with none typed the key has to pass.
  const keyChecked = check.status === 'ok' || (check.status === 'refused' && address.trim() !== '' && !addressProblem);
  const canAdd = keyChecked && regionPicked && models.length > 0 && name.trim() !== '' && !addressProblem;
  // The models the company listed for the key, to tick; typed instead when it has no list, the list couldn't be read, or the company
  // turned the key away (it may still be added for an address typed under Its own address)
  const listed = check.status === 'ok' ? check.listed : null;
  // The models to tick: the ones Universe starts this company's keys on first (with the company's line when it lists them too), then
  // the rest of the company's list
  const options: Listed[] | null =
    listed && info
      ? [
          ...known.map((model) => ({ ...model, ...(listed.find((entry) => entry.id === model.id)?.note ? { note: listed.find((entry) => entry.id === model.id)!.note } : {}) })),
          ...listed.filter((entry) => !known.some((model) => model.id === entry.id)),
        ]
      : null;
  const typing = !modelList || (check.status === 'ok' && !listed) || check.status === 'refused';

  async function add() {
    if (!info || !canAdd) return;
    setSaving(true);
    setFailure(null);
    // On from the start: its key was just checked, and Universe AI can't use it until it's on
    const answer = await callOrbit('POST', '/api/admin/voice-providers', {
      adapter: info.adapter,
      name: name.trim(),
      recognition: job === 'recognition',
      speech: job === 'speech',
      enabled: true,
      apiKey: fullKey,
      ...(account?.regions && region ? { region } : {}),
      models,
      ...(address.trim() ? { endpoint: address.trim() } : {}),
    });
    if (!answer.ok) {
      setFailure(answer.error);
      setSaving(false);
      return;
    }
    addToast({ description: `${name.trim()} added`, variant: 'success', duration: 2500 });
    router.push('/admin/ai-providers');
  }

  // Parts count on from 1: the region comes only for a company whose keys are made per region
  let part = 1;
  return (
    <div className="grid gap-6" data-testid="new-voice-provider">
      <PageHeader icon={<KeyRound size={30} aria-hidden="true" />} title="New voice provider">
        <p className="max-w-[60ch] text-[15px] text-muted-foreground">A speech company Universe AI can listen or speak with, on Universe’s own key.</p>
      </PageHeader>
      {!info ? (
        <div className="grid w-full max-w-[720px] gap-4 rounded-3xl border border-foreground/10 bg-foreground/[.03] p-4" data-testid="step-pick">
          <div className="grid gap-0.5">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Step 1 of 2</span>
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">Pick a company</h2>
          </div>
          {JOBS.map(({ job: each, word }) => (
            <div key={each} className="grid gap-2" role="radiogroup" aria-label={word}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{word}</h3>
              {VOICE_KEY_COMPANIES.filter((entry) => COMPANY_JOBS[entry.adapter]?.includes(each)).map((entry) => (
                <PickCard key={entry.adapter} role="radio" picked={false} onClick={() => pick(entry.adapter, each)} indicator={<ProviderLogo info={entry} />} trailing={<Radio checked={false} className="mt-0.5 self-start" />} title={entry.label} description={benefitOf(entry)} className="items-start" />
              ))}
            </div>
          ))}
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
              <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">Set up {info.label}</h2>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)] px-3.5 py-2.5" data-testid="picked-provider">
              <ProviderLogo info={info} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{info.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{benefitOf(info)}</span>
              </span>
              <Button type="button" variant="outline" className="h-11 shrink-0 px-4" disabled={saving} onClick={() => setAdapter(null)}>
                Change
              </Button>
            </div>
          </div>
          <Part n={part++} title={`Get Universe’s ${info.label} key`}>
            <div className="grid gap-1 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-3 text-[13px]">{info.step}</div>
          </Part>
          {account?.regions && (
            <Part n={part++} title="Pick the region">
              <div role="radiogroup" aria-label="Region" className="grid gap-2 sm:grid-cols-2">
                {account.regions.map((entry) => (
                  <PickCard
                    key={entry.id}
                    role="radio"
                    picked={region === entry.id}
                    onClick={() => {
                      if (entry.id === region) return;
                      latest.current += 1;
                      setRegion(entry.id);
                      setCheck({ status: 'none' });
                    }}
                    indicator={<Radio checked={region === entry.id} />}
                    title={entry.label}
                    description={entry.host}
                  />
                ))}
              </div>
              <p className={FIELD_HINT}>{account.regionHint ?? 'A key only works in the region it was made in.'}</p>
            </Part>
          )}
          <Part n={part++} title={account?.keyId ? 'Paste the access key' : 'Paste the key'}>
            {account?.keyId && (
              <div className="grid gap-1.5">
                <Label htmlFor="voice-key-id">{account.keyId.label}</Label>
                <Input
                  id="voice-key-id"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={account.keyId.example}
                  value={keyId}
                  onChange={(event) => {
                    latest.current += 1;
                    setKeyId(event.target.value);
                    setCheck({ status: 'none' });
                  }}
                  className="h-11 rounded-xl"
                />
                <p className={FIELD_HINT}>{account.keyId.hint}</p>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="voice-key">{account?.keyLabel ?? 'API key'}</Label>
              <Input
                id="voice-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={account?.keyLabel ? `Paste the ${account.keyLabel.toLowerCase()}` : 'Paste the key'}
                value={apiKey}
                onChange={(event) => {
                  latest.current += 1;
                  setApiKey(event.target.value);
                  setCheck({ status: 'none' });
                }}
                className="h-11 rounded-xl"
              />
              <p className={FIELD_HINT}>Stored encrypted. Nobody sees it again, not even you.</p>
            </div>
            <div className="grid gap-2" aria-live="polite">
              <Button type="button" variant="outline" className="h-11" disabled={!keyTyped || !regionPicked || check.status === 'checking'} onClick={() => void checkKey()}>
                <ShieldCheck aria-hidden="true" />
                {check.status === 'checking' ? 'Checking…' : 'Check key'}
              </Button>
              {check.status === 'none' && (
                <p className={FIELD_HINT}>
                  Asks {info.label} if it knows the key{modelList ? ' and which models it has' : ''}. Nothing is spoken or heard, so nothing is paid.
                  {address.trim() !== '' && ` The check goes to ${info.label}’s own address, not the one under Its own address.`}
                </p>
              )}
              {check.status === 'ok' && (
                <Answered>
                  {info.label} knows this key{check.listed ? ` and lists ${check.listed.length} ${check.listed.length === 1 ? 'model' : 'models'} for it` : ''}. Nothing was spoken, so nothing was paid.
                </Answered>
              )}
              {check.status === 'refused' && <Refused>{check.message}</Refused>}
              {check.status === 'refused' && address.trim() !== '' && !addressProblem && (
                <p className={FIELD_HINT}>This check goes to {info.label}’s own address, so it may not know a key made for the address you typed. You can still add it.</p>
              )}
            </div>
          </Part>
          <Part n={part++} title="Its models">
            {options ? (
              <>
                <p className={FIELD_HINT}>
                  {info.label} lists these, each with what {info.label} says about it. One that works is ticked already. Tick more to let bots pick between them: bots on Universe AI, and people’s own {info.label} keys, can use only the ticked ones. The first ticked is what bots start on.
                </p>
                <VoiceModelPicker
                  models={options}
                  mode="many"
                  detailed
                  label={`${info.label} models`}
                  picked={models.map(lendModelId)}
                  // What is saved is the model only: the line about it is the company's, read again whenever the list is
                  onChange={(ids) => setModels(ids.flatMap((id) => options.filter((entry) => lendModelId(entry) === id).map(({ id: modelId, label, kind }) => ({ id: modelId, ...(label ? { label } : {}), kind }))))}
                />
              </>
            ) : typing ? (
              <>
                <p className={FIELD_HINT}>
                  {modelList
                    ? check.status === 'refused'
                      ? `Tick the models Universe knows for ${info.label}, or type one as ${info.label} writes it.`
                      : `Couldn’t read ${info.label}’s list of models. Tick the ones Universe knows for it, or type one as ${info.label} writes it.`
                    : `${info.label} doesn’t share a list of its models. Tick the ones Universe knows for it, or type one as ${info.label} writes it.`}{' '}
                  Bots on Universe AI, and people’s own {info.label} keys, can use only the models listed here. The first one is what bots start on.
                </p>
                {known.length > 0 && (
                  <VoiceModelPicker
                    models={known}
                    mode="many"
                    label={`${info.label} models`}
                    picked={models.map(lendModelId)}
                    onChange={(ids) =>
                      // Ticking keeps a typed model where it is; a model ticked off goes, one ticked on goes last
                      setModels([
                        ...models.filter((model) => ids.includes(lendModelId(model)) || !known.some((start) => lendModelId(start) === lendModelId(model))),
                        ...known.filter((start) => ids.includes(lendModelId(start)) && !models.some((model) => lendModelId(model) === lendModelId(start))),
                      ])
                    }
                  />
                )}
                <ModelRows models={models} jobs={[job]} onChange={setModels} disabled={saving} />
              </>
            ) : (
              <p className={FIELD_HINT}>Check the key and {info.label}’s models show here to tick.</p>
            )}
          </Part>
          <Part n={part++} title="Name it">
            <Input aria-label="Name" value={name} maxLength={255} onChange={(event) => setTypedName(event.target.value)} className="h-11 rounded-xl" />
            <p className={FIELD_HINT}>Shown here and on bot pages.</p>
          </Part>
          <button type="button" aria-expanded={showAddress} className="flex h-11 w-fit items-center gap-1.5 text-sm font-semibold text-muted-foreground" onClick={() => setShowAddress((open) => !open)}>
            <ChevronDown size={16} aria-hidden="true" className={showAddress ? 'rotate-180' : ''} />
            Its own address
          </button>
          {showAddress && (
            <div className="grid gap-1.5">
              <Label htmlFor="voice-address">Address</Label>
              <Input id="voice-address" type="url" inputMode="url" autoComplete="off" placeholder={`${wssAllowed ? 'wss' : 'https'}://${companyHost(info.adapter, job)}`} value={address} onChange={(event) => setAddress(event.target.value)} className="h-11 rounded-xl" aria-invalid={addressProblem ? true : undefined} />
              <p className={FIELD_HINT}>Leave empty to use {info.label}’s own ({companyHost(info.adapter, job)}). Must start with {wssAllowed ? 'https:// or wss://' : 'https://'}.</p>
              {addressProblem && <Refused>{addressProblem}</Refused>}
            </div>
          )}
          {failure && <Refused>{failure}</Refused>}
          <div className="grid gap-2">
            <Button type="submit" className="h-11" disabled={!canAdd || saving}>
              {saving ? 'Adding…' : 'Add provider'}
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
