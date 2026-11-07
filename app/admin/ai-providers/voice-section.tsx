'use client';

/*
 * The Voice part of the Universe AI page (#792, design A): what Universe AI listens and speaks with, the voice providers, and the
 * companies people can add their own voice key for.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AudioLines, Ear, Info, Loader2, Pause, Play, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PickCard, Radio } from '@/components/ui/choice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { EntityRow, LoadError, LoadingRows, SectionHeader, StatLine } from '../components/ds';
import { ProviderLogo } from '../components/ds/provider-logo';
import { FormSheet } from '../components/form-sheet';
import { EnabledPill } from './components/provider-state';
import {
  Caption,
  DefaultPills,
  FIELD_HINT,
  Refused,
  bots,
  botsOn,
  callOrbit,
  companyLabel,
  defaultChangeLine,
  offJobs,
  doesLine,
  logoOf,
  modelName,
  startingModel,
  useVoiceProviders,
  withStartingModel,
  type ServerVoiceProvider,
  type VoiceJob,
} from './voice/voice-shared';

/** One "Universe AI listens / speaks with" row: what it is now and a Change button. */
function DefaultRow({ icon, label, value, hint, onChange, testId, disabled }: { icon: ReactNode; label: string; value: ReactNode; hint: ReactNode; onChange: () => void; testId: string; disabled?: boolean }) {
  return (
    <div className="flex min-h-16 w-full items-center gap-3.5 rounded-[14px] border border-border bg-card px-3.5 py-3" data-testid={testId}>
      <span className="shrink-0 text-foreground/85">{icon}</span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
        <strong className="text-[15px] font-semibold [overflow-wrap:anywhere]">{value}</strong>
        <span className="text-xs leading-snug text-muted-foreground">{hint}</span>
      </span>
      <Button variant="outline" className="h-11 shrink-0 px-4" disabled={disabled} onClick={onChange}>
        Change
      </Button>
    </div>
  );
}

function SheetButtons({ go, busy, onClose, disabled, onGo }: { go: string; busy?: boolean; onClose: () => void; disabled?: boolean; onGo: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button className="h-11 px-5" disabled={disabled || busy} onClick={onGo}>
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
        {go}
      </Button>
    </div>
  );
}

function ModelSelect({ label, models, value, onChange }: { label: string; models: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <span id="voice-model-label" className="text-sm font-medium">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-labelledby="voice-model-label" className="h-11 rounded-xl px-3 text-[15px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}


/** Why a provider can't be picked as the default for a job, or null. */
function whyNot(provider: ServerVoiceProvider, job: VoiceJob): string | null {
  if (!provider.enabled) return 'Disabled. Enable it to pick it.';
  if (!provider.hasKey) return 'It has no key yet.';
  if (!startingModel(provider, job)) return `It lists no ${job === 'recognition' ? 'listening' : 'speaking'} model yet.`;
  return null;
}

/** The provider and model a sheet opens on: the current default, else the first one that can be picked. */
function opensOn(candidates: ServerVoiceProvider[], job: VoiceJob) {
  const current = candidates.find((provider) => (job === 'recognition' ? provider.defaultRecognition : provider.defaultSpeech));
  return current ?? candidates.find((provider) => !whyNot(provider, job)) ?? null;
}

interface SheetProps {
  open: boolean;
  providers: ServerVoiceProvider[];
  onClose: () => void;
  onSaved: () => void;
}

/** Saves a company, model and (for speaking) voice as Universe AI's default; the sheet closes only when it was saved. */
function useSaveDefault(onSaved: () => void, onClose: () => void) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function save(provider: ServerVoiceProvider, change: Record<string, unknown>, said: string) {
    setBusy(true);
    setFailure(null);
    const answer = await callOrbit('PATCH', `/api/admin/voice-providers/${encodeURIComponent(provider.id)}`, change);
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.error);
      return;
    }
    addToast({ description: said, variant: 'success', duration: 2500 });
    onSaved();
    onClose();
  }
  return { busy, failure, save, reset: () => setFailure(null) };
}

function ListenSheet({ open, providers, onClose, onSaved }: SheetProps) {
  const candidates = providers.filter((provider) => provider.recognition);
  const start = opensOn(candidates, 'recognition');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const { busy, failure, save, reset } = useSaveDefault(onSaved, onClose);
  useEffect(() => {
    if (!open) return;
    reset();
    setPickedId(start?.id ?? null);
    setModelId(start ? (startingModel(start, 'recognition')?.id ?? null) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const picked = candidates.find((provider) => provider.id === pickedId) ?? null;
  const models = picked ? picked.models.filter((model) => model.kind === 'recognition') : [];
  const unchanged = !picked || (picked.defaultRecognition && modelId === startingModel(picked, 'recognition')?.id);
  return (
    <FormSheet open={open} onOpenChange={(next) => !next && !busy && onClose()} title="Universe AI listens with">
      <div role="radiogroup" aria-label="Company" className="grid gap-2">
        {candidates.map((provider) => {
          const reason = whyNot(provider, 'recognition');
          const isPicked = pickedId === provider.id;
          return (
            <PickCard
              key={provider.id}
              role="radio"
              picked={isPicked}
              disabled={reason !== null}
              onClick={() => {
                setPickedId(provider.id);
                setModelId(startingModel(provider, 'recognition')?.id ?? null);
              }}
              indicator={<ProviderLogo info={logoOf(provider.adapter)} />}
              trailing={<Radio checked={isPicked} />}
              title={provider.name}
              description={reason ?? `${modelName(startingModel(provider, 'recognition')!)} · key ••••${provider.apiKeyLast4 ?? ''}`}
            />
          );
        })}
        {candidates.length === 0 && <p className={FIELD_HINT}>No voice provider listens yet. Add one first.</p>}
      </div>
      {picked && modelId && <ModelSelect label="Listening model" models={models.map((model) => ({ id: model.id, name: modelName(model) }))} value={modelId} onChange={setModelId} />}
      <p className={FIELD_HINT} data-testid="listen-change-line">
        {defaultChangeLine(providers, picked, 'recognition', Boolean(picked && modelId && modelId !== startingModel(picked, 'recognition')?.id))}
      </p>
      {failure && <Refused>{failure}</Refused>}
      <SheetButtons
        go="Save"
        busy={busy}
        disabled={unchanged || !modelId}
        onClose={onClose}
        onGo={() => {
          if (!picked || !modelId) return;
          void save(picked, { defaultRecognition: true, models: withStartingModel(picked.models, 'recognition', modelId) }, `Universe AI listens with ${picked.name}`);
        }}
      />
    </FormSheet>
  );
}

interface Voice {
  voiceId: string;
  name: string;
  description: string;
  languages: string[];
  previewUrl: string | null;
}

type Voices = { status: 'loading' } | { status: 'ready'; voices: Voice[] } | { status: 'failed'; message: string };

const LANGUAGE_NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
const languageName = (code: string) => {
  try {
    return LANGUAGE_NAMES?.of(code) ?? code;
  } catch {
    return code;
  }
};

/** At most this many voices are drawn at once; searching narrows the rest. */
const SHOWN_VOICES = 100;

/** Plays one voice's free sample, one at a time. A sample that needs the key is fetched through Orbit. */
function useSamples() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const link = useRef<string | null>(null);
  // Goes up with every start and stop: a sample that is still being fetched when it changes is dropped, never played
  const turn = useRef(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  function stop() {
    turn.current += 1;
    audio.current?.pause();
    audio.current = null;
    if (link.current) URL.revokeObjectURL(link.current);
    link.current = null;
    setPlaying(null);
  }
  useEffect(() => stop, []);
  async function play(voice: Voice) {
    if (playing === voice.voiceId) return stop();
    stop();
    if (!voice.previewUrl) return;
    const mine = turn.current;
    setFailed(null);
    setPlaying(voice.voiceId);
    let fetched: string | null = null;
    try {
      let src = voice.previewUrl;
      if (src.startsWith('/')) {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(src);
        if (!response.ok) throw new Error('sample');
        const blob = await response.blob();
        if (mine !== turn.current) return;
        fetched = URL.createObjectURL(blob);
        src = fetched;
      }
      const element = new Audio(src);
      element.onended = stop;
      audio.current = element;
      link.current = fetched;
      await element.play();
    } catch {
      // Stopped, or another sample started, while this one was loading: nothing to say
      if (mine !== turn.current) {
        if (fetched && link.current !== fetched) URL.revokeObjectURL(fetched);
        return;
      }
      stop();
      setFailed(`Couldn’t play ${voice.name}’s sample.`);
    }
  }
  return { playing, failed, play, stop };
}

function SpeakSheet({ open, providers, onClose, onSaved }: SheetProps) {
  const candidates = providers.filter((provider) => provider.speech);
  const start = opensOn(candidates, 'speech');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voices, setVoices] = useState<Voices>({ status: 'loading' });
  const [find, setFind] = useState('');
  const { busy, failure, save, reset } = useSaveDefault(onSaved, onClose);
  const samples = useSamples();
  useEffect(() => {
    if (!open) return;
    reset();
    setFind('');
    setPickedId(start?.id ?? null);
    setModelId(start ? (startingModel(start, 'speech')?.id ?? null) : null);
    setVoiceId(start?.defaultVoiceId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) samples.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The voices of whichever company is picked, from the company's own free list
  useEffect(() => {
    if (!open || !pickedId) return;
    let current = true;
    setVoices({ status: 'loading' });
    void callOrbit<{ voices: Voice[] }>('GET', `/api/admin/voice-providers/${encodeURIComponent(pickedId)}/voices`).then((answer) => {
      if (!current) return;
      setVoices(answer.ok ? { status: 'ready', voices: answer.data.voices } : { status: 'failed', message: answer.error });
    });
    return () => {
      current = false;
    };
  }, [open, pickedId]);

  const picked = candidates.find((provider) => provider.id === pickedId) ?? null;
  const models = picked ? picked.models.filter((model) => model.kind === 'speech') : [];
  const all = voices.status === 'ready' ? voices.voices : [];
  const needle = find.trim().toLowerCase();
  const matching = needle === '' ? all : all.filter((voice) => `${voice.name} ${voice.description}`.toLowerCase().includes(needle));
  const pickedVoice = all.find((voice) => voice.voiceId === voiceId) ?? null;
  const shown = matching.slice(0, SHOWN_VOICES);
  // The voice that is picked stays on screen however the list is searched
  const rows = pickedVoice && !shown.includes(pickedVoice) ? [pickedVoice, ...shown] : shown;
  const voiceChanged = voiceId !== (picked?.defaultVoiceId ?? null);
  const unchanged = !picked || (picked.defaultSpeech && modelId === startingModel(picked, 'speech')?.id && !voiceChanged);
  const company = picked ? companyLabel(picked.adapter) : '';

  return (
    <FormSheet open={open} onOpenChange={(next) => !next && !busy && onClose()} title="Universe AI speaks with">
      <div role="radiogroup" aria-label="Company" className="grid gap-2 sm:grid-cols-2">
        {candidates.map((provider) => {
          const reason = whyNot(provider, 'speech');
          const isPicked = pickedId === provider.id;
          return (
            <PickCard
              key={provider.id}
              role="radio"
              picked={isPicked}
              disabled={reason !== null}
              onClick={() => {
                if (provider.id === pickedId) return;
                samples.stop();
                setPickedId(provider.id);
                setModelId(startingModel(provider, 'speech')?.id ?? null);
                // A voice belongs to its company: the one saved for this provider, if it has one
                setVoiceId(provider.defaultVoiceId);
                setFind('');
              }}
              indicator={<ProviderLogo info={logoOf(provider.adapter)} />}
              trailing={<Radio checked={isPicked} />}
              title={provider.name}
              description={reason ?? `key ••••${provider.apiKeyLast4 ?? ''}`}
            />
          );
        })}
        {candidates.length === 0 && <p className={FIELD_HINT}>No voice provider speaks yet. Add one first.</p>}
      </div>
      {picked && modelId && <ModelSelect label="Speaking model" models={models.map((model) => ({ id: model.id, name: modelName(model) }))} value={modelId} onChange={setModelId} />}
      {picked && (
        <div className="grid gap-2">
          <span className="text-sm font-medium">Starting voice</span>
          {voices.status === 'loading' && <LoadingRows label="the voices" rows={2} />}
          {voices.status === 'failed' && (
            <p className={FIELD_HINT} role="status">
              {voices.message} Without a voice picked, bots start with the first voice {company} lists.
            </p>
          )}
          {voices.status === 'ready' && (
            <>
              <div className="relative">
                <Search size={16} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input type="search" aria-label="Search voices" placeholder={`Search ${all.length.toLocaleString('en')} voices`} value={find} onChange={(event) => setFind(event.target.value)} className="h-11 rounded-full pl-10" />
              </div>
              <p className={FIELD_HINT}>Samples come from {company}, free.</p>
              <div role="radiogroup" aria-label="Voice" className="grid max-h-[300px] gap-0 overflow-auto rounded-2xl border border-foreground/10" data-testid="voice-list">
                {rows.map((voice) => {
                  const isPicked = voice.voiceId === voiceId;
                  const languages = voice.languages.map(languageName).join(', ');
                  return (
                    <div key={voice.voiceId} className={`flex min-h-14 items-center gap-3 border-t border-foreground/10 px-3 py-1.5 first:border-t-0 ${isPicked ? 'bg-[rgba(134,41,252,.14)] shadow-[inset_0_0_0_1px_rgba(167,139,250,.7)]' : ''}`} data-picked={isPicked}>
                      <button type="button" role="radio" aria-checked={isPicked} onClick={() => setVoiceId(voice.voiceId)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left">
                        <Radio checked={isPicked} />
                        <span className="grid min-w-0 flex-1">
                          <strong className="text-[15px] font-semibold [overflow-wrap:anywhere]">{voice.name}</strong>
                          <span className="text-xs text-muted-foreground">{[voice.description, languages].filter(Boolean).join(' ')}</span>
                        </span>
                      </button>
                      {voice.previewUrl ? (
                        <button
                          type="button"
                          aria-label={`${samples.playing === voice.voiceId ? 'Stop' : 'Play'} ${voice.name}`}
                          onClick={() => void samples.play(voice)}
                          className="grid h-11 w-11 shrink-0 place-content-center rounded-full hover:bg-foreground/[0.08]"
                        >
                          {samples.playing === voice.voiceId ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
                        </button>
                      ) : (
                        <span className="w-11 shrink-0" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
                {matching.length === 0 && <p className="p-3 text-sm text-muted-foreground">No voice matches that.</p>}
              </div>
              {matching.length > SHOWN_VOICES && <p className={FIELD_HINT}>Showing {SHOWN_VOICES} of {matching.length.toLocaleString('en')}. Search to narrow them.</p>}
              {samples.failed && <Refused>{samples.failed}</Refused>}
              {voiceId === null && <p className={FIELD_HINT}>No voice picked: bots start with the first voice {company} lists.</p>}
            </>
          )}
        </div>
      )}
      <p className={FIELD_HINT} data-testid="speak-change-line">
        {defaultChangeLine(providers, picked, 'speech', Boolean(picked && modelId && modelId !== startingModel(picked, 'speech')?.id))}
      </p>
      {failure && <Refused>{failure}</Refused>}
      <SheetButtons
        go="Save"
        busy={busy}
        disabled={unchanged || !modelId}
        onClose={onClose}
        onGo={() => {
          if (!picked || !modelId) return;
          samples.stop();
          void save(
            picked,
            {
              defaultSpeech: true,
              models: withStartingModel(picked.models, 'speech', modelId),
              ...(voiceId !== null && voiceChanged ? { defaultVoiceId: voiceId, defaultVoiceName: pickedVoice?.name ?? null } : {}),
            },
            `Universe AI speaks with ${picked.name}`
          );
        }}
      />
    </FormSheet>
  );
}

function OffSheet({ provider, providers, onClose, onSaved }: { provider: ServerVoiceProvider | null; providers: ServerVoiceProvider[]; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { addToast } = useToast();
  // People can add a company's key while any provider of it is on
  const stillOn = provider ? providers.some((other) => other.id !== provider.id && other.adapter === provider.adapter && other.enabled) : true;
  const jobs = provider ? offJobs(provider, providers) : [];
  const company = provider ? companyLabel(provider.adapter) : '';
  async function disable() {
    if (!provider) return;
    setBusy(true);
    setFailure(null);
    const answer = await callOrbit('PATCH', `/api/admin/voice-providers/${encodeURIComponent(provider.id)}`, { enabled: false });
    setBusy(false);
    if (!answer.ok) {
      setFailure(answer.error);
      return;
    }
    addToast({ description: `${provider.name} is off`, variant: 'success', duration: 2500 });
    onSaved();
    onClose();
  }
  return (
    <FormSheet open={provider !== null} onOpenChange={(next) => !next && !busy && onClose()} title={provider ? `Disable ${provider.name}?` : 'Disable?'}>
      {jobs.map((each) => (
        <div key={each.job} className="grid gap-3" data-testid={`off-${each.job}`}>
          {each.to && (
            <div className="flex items-center gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-3">
              <ProviderLogo info={logoOf(each.to.adapter)} />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-[15px] font-semibold">{each.job === 'speech' ? `${each.count === 1 ? 'It speaks' : 'They speak'} as ${each.voice} on ${each.to.name}` : `${each.count === 1 ? 'It listens' : 'They listen'} with ${each.to.name}`}</span>
                <span className="text-[13px] text-muted-foreground">{each.job === 'speech' ? 'What Universe AI speaks with now' : 'What Universe AI listens with now'}</span>
              </span>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{each.line}</p>
        </div>
      ))}
      {!stillOn && <p className="text-sm text-muted-foreground">{`People can’t add a ${company} key while no ${company} provider is on.`}</p>}
      {failure && <Refused>{failure}</Refused>}
      <SheetButtons go="Disable" busy={busy} onClose={onClose} onGo={() => void disable()} />
    </FormSheet>
  );
}

/** Design A: the defaults, the providers, and which companies people can add keys for. */
export function VoiceSection() {
  const { providers, failed, loading, reload } = useVoiceProviders();
  const { addToast } = useToast();
  const [sheet, setSheet] = useState<'listen' | 'speak' | null>(null);
  const [off, setOff] = useState<ServerVoiceProvider | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const companies = useMemo(() => Array.from(new Set((providers ?? []).filter((provider) => provider.enabled).map((provider) => companyLabel(provider.adapter)))), [providers]);

  async function enable(provider: ServerVoiceProvider) {
    setToggling(provider.id);
    const answer = await callOrbit('PATCH', `/api/admin/voice-providers/${encodeURIComponent(provider.id)}`, { enabled: true });
    setToggling(null);
    if (!answer.ok) {
      addToast({ description: answer.error, variant: 'error' });
      return;
    }
    addToast({ description: `${provider.name} is on`, variant: 'success', duration: 2500 });
    reload();
  }

  const listener = providers?.find((provider) => provider.defaultRecognition) ?? null;
  const speaker = providers?.find((provider) => provider.defaultSpeech) ?? null;

  return (
    <section className="grid min-w-0 gap-4" aria-labelledby="voice" data-testid="voice-section">
      <SectionHeader id="voice" title="Voice" action={{ href: '/admin/ai-providers/voice/new', label: 'New voice provider', icon: Plus }} />
      {failed ? (
        <LoadError label="the voice providers" retry={reload} />
      ) : !providers ? (
        <LoadingRows label="the voice providers" rows={3} />
      ) : providers.length === 0 ? (
        <div className="grid gap-3 rounded-[14px] border border-border bg-card p-4" data-testid="voice-empty">
          <strong className="text-[15px]">Universe AI has no voice yet</strong>
          <p className="text-sm text-muted-foreground">Bots on Universe AI answer in text, and nobody can add a voice key of their own. Add one company that listens and one that speaks.</p>
          <Button asChild variant="outline" className="h-11 w-fit px-5">
            <Link href="/admin/ai-providers/voice/new">
              <Plus className="mr-2 h-4 w-4" />
              New voice provider
            </Link>
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">What bots on Universe AI listen and speak with. People with Manage bots turn voice on for each bot.</p>
          <div className="grid gap-2">
            <DefaultRow
              testId="default-listen"
              icon={<Ear size={22} aria-hidden="true" />}
              label="Universe AI listens with"
              value={listener ? `${listener.name} · ${modelName(startingModel(listener, 'recognition') ?? { id: 'no model', kind: 'recognition' })}` : 'Nothing yet'}
              hint={listener ? `A bot that turns voice on starts with this. Bots on ${listener.name} listen with this model too.` : 'Bots can’t turn voice on with Universe AI until a company listens for it.'}
              disabled={loading}
              onChange={() => setSheet('listen')}
            />
            <DefaultRow
              testId="default-speak"
              icon={<AudioLines size={22} aria-hidden="true" />}
              label="Universe AI speaks with"
              value={speaker ? [speaker.defaultVoiceName ?? (speaker.defaultVoiceId ? 'A saved voice' : null), speaker.name, modelName(startingModel(speaker, 'speech') ?? { id: 'no model', kind: 'speech' })].filter(Boolean).join(' · ') : 'Nothing yet'}
              hint={
                !speaker
                  ? 'Bots can’t turn voice on with Universe AI until a company speaks for it.'
                  : speaker.defaultVoiceId
                    ? `A bot that turns voice on starts with this voice. Bots on ${speaker.name} speak with this model too, in their own voices.`
                    : `No starting voice picked: a bot that turns voice on starts with the first voice ${speaker.name} lists. Bots on ${speaker.name} speak with this model too, in their own voices.`
              }
              disabled={loading}
              onChange={() => setSheet('speak')}
            />
          </div>
          <Caption>Voice providers</Caption>
          <div className="grid min-w-0 gap-0.5">
            {providers.map((provider) => {
              const isDefault = provider.defaultRecognition || provider.defaultSpeech;
              return (
                <EntityRow
                  key={provider.id}
                  href={`/admin/ai-providers/voice/${provider.id}`}
                  kind="provider"
                  leading={<ProviderLogo info={logoOf(provider.adapter)} />}
                  title={provider.name}
                  chevron={isDefault}
                  titleAside={isDefault && <DefaultPills provider={provider} />}
                  context={<StatLine items={[doesLine(provider), provider.models.map(modelName).join(', ') || 'No models yet', provider.hasKey ? `key ••••${provider.apiKeyLast4 ?? ''}` : 'No key yet', botsOn(provider) > 0 && bots(botsOn(provider))]} />}
                  aside={<EnabledPill enabled={provider.enabled} />}
                  // The default can't be turned off: Universe AI always has one to listen or speak with
                  trailing={
                    isDefault ? null : provider.enabled ? (
                      <Button variant="outline" className="h-11" aria-label={`Disable ${provider.name}`} onClick={() => setOff(provider)}>
                        Disable
                      </Button>
                    ) : (
                      <Button variant="outline" className="h-11" aria-label={`Enable ${provider.name}`} disabled={toggling === provider.id} onClick={() => void enable(provider)}>
                        {toggling === provider.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Enable
                      </Button>
                    )
                  }
                />
              );
            })}
          </div>
          <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground" data-testid="people-line">
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            {companies.length > 0 ? `People can add their own voice key for the companies that are on here: ${companies.join(', ')}.` : 'No company is on here, so people can’t add a voice key of their own.'}
          </p>
        </>
      )}
      <ListenSheet open={sheet === 'listen'} providers={providers ?? []} onClose={() => setSheet(null)} onSaved={reload} />
      <SpeakSheet open={sheet === 'speak'} providers={providers ?? []} onClose={() => setSheet(null)} onSaved={reload} />
      <OffSheet key={off?.id ?? 'none'} provider={off} providers={providers ?? []} onClose={() => setOff(null)} onSaved={reload} />
    </section>
  );
}
