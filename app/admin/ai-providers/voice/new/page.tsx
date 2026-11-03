'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PickCard, Radio } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { VOICE_KEY_COMPANIES, type VoiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import type { VoiceModel } from '@/lib/voice-providers';
import { PageHeader } from '../../../components/ds';
import { ProviderLogo } from '../../../components/ds/provider-logo';
import { Answered, COMPANY_HOST, COMPANY_JOBS, FIELD_HINT, JOBS, ModelRows, Refused, callOrbit, type VoiceJob } from '../voice-shared';

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

const jobOf = (info: VoiceKeyCompanyInfo): VoiceJob => COMPANY_JOBS[info.adapter] ?? 'speech';
/** The company's own line with what it does in Universe filled in: "Speaks, with thousands of voices." */
const benefitOf = (info: VoiceKeyCompanyInfo) => info.benefit.replace('{does}', jobOf(info) === 'recognition' ? 'Listens' : 'Speaks');

type Check = { status: 'none' } | { status: 'checking' } | { status: 'ok' } | { status: 'refused'; message: string };

/**
 * New voice provider (#792): one company Universe AI can listen or speak with, on Universe's own key. Two steps like Add a key:
 * pick a company, then set it up (get the key, paste and check it for free, type its models, name it). Add provider stays off until
 * the company has accepted the key and one model is listed.
 */
export default function NewVoiceProviderPage() {
  const router = useRouter();
  const { addToast } = useToast();
  const [adapter, setAdapter] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
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

  const info = VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter && COMPANY_JOBS[entry.adapter]) ?? null;
  const job = info ? jobOf(info) : 'speech';
  const name = typedName ?? info?.label ?? '';
  const wssAllowed = job === 'recognition';

  function pick(next: string) {
    if (next !== adapter) {
      latest.current += 1;
      setAdapter(next);
      // A key typed for one company is never sent to another
      setApiKey('');
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
    const answer = await callOrbit('POST', '/api/admin/voice-providers/check', { adapter: info.adapter, apiKey });
    if (mine !== latest.current) return;
    setCheck(answer.ok ? { status: 'ok' } : { status: 'refused', message: answer.error });
  }

  const addressProblem =
    address.trim() === '' ? null : /^https:\/\//i.test(address.trim()) || (wssAllowed && /^wss:\/\//i.test(address.trim())) ? null : `The address must start with ${wssAllowed ? 'https:// or wss://' : 'https://'}.`;
  const canAdd = check.status === 'ok' && models.length > 0 && name.trim() !== '' && !addressProblem;

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
      apiKey: apiKey.trim(),
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
              {VOICE_KEY_COMPANIES.filter((entry) => COMPANY_JOBS[entry.adapter] === each).map((entry) => (
                <PickCard key={entry.adapter} role="radio" picked={false} onClick={() => pick(entry.adapter)} indicator={<ProviderLogo info={entry} />} trailing={<Radio checked={false} className="mt-0.5 self-start" />} title={entry.label} description={benefitOf(entry)} className="items-start" />
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
          <Part n={1} title={`Get Universe’s ${info.label} key`}>
            <div className="grid gap-1 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-3 text-[13px]">{info.step}</div>
          </Part>
          <Part n={2} title="Paste the key">
            <div className="grid gap-1.5">
              <Label htmlFor="voice-key">API key</Label>
              <Input
                id="voice-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the key"
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
              <Button type="button" variant="outline" className="h-11" disabled={apiKey.trim() === '' || check.status === 'checking'} onClick={() => void checkKey()}>
                <ShieldCheck aria-hidden="true" />
                {check.status === 'checking' ? 'Checking…' : 'Check key'}
              </Button>
              {check.status === 'none' && <p className={FIELD_HINT}>Asks {info.label} if it knows the key. Nothing is spoken or heard, so nothing is paid.</p>}
              {check.status === 'ok' && <Answered>{info.label} knows this key. Nothing was spoken, so nothing was paid.</Answered>}
              {check.status === 'refused' && <Refused>{check.message}</Refused>}
            </div>
          </Part>
          <Part n={3} title="Its models">
            <p className={FIELD_HINT}>Type each model as {info.label} writes it. Bots on Universe AI, and people’s own {info.label} keys, can use only the models listed here. The first one is what bots start on.</p>
            <ModelRows models={models} jobs={[job]} onChange={setModels} disabled={saving} />
          </Part>
          <Part n={4} title="Name it">
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
              <Input id="voice-address" type="url" inputMode="url" autoComplete="off" placeholder={`${wssAllowed ? 'wss' : 'https'}://${COMPANY_HOST[info.adapter]}`} value={address} onChange={(event) => setAddress(event.target.value)} className="h-11 rounded-xl" aria-invalid={addressProblem ? true : undefined} />
              <p className={FIELD_HINT}>Leave empty to use {info.label}’s own ({COMPANY_HOST[info.adapter]}). Must start with {wssAllowed ? 'https:// or wss://' : 'https://'}.</p>
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
