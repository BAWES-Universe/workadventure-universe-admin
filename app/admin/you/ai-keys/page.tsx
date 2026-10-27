'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, Globe, KeyRound, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LimitGroup, keyLimitsLine, replyLimits, useSaveKeyLimit } from '../../components/limits';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { authenticatedFetch } from '@/lib/client-auth';
import type { AiKeySummary } from '@/lib/ai-keys';
import { LoadError, LoadingRows, PageHeader, count } from '../../components/ds';
import { FormSheet } from '../../components/form-sheet';
import { Planet } from '../../components/ds/planet-icon';
import { ProviderLogo } from '../../components/ds/provider-logo';
import { ModelCaps, sharedCaps } from '../../components/ds/model-caps';
import { ModelPicker } from '../../components/ds/model-picker';
import { kindInfo } from '@/lib/ai-key-kinds';
import { PickCard, Radio, Segmented } from '@/components/ui/choice';
import { AiKeyFailure, aiKeyError, aiKeyFailureText, useAiKeys } from '../../hooks/use-ai-keys';

/** 880000 -> "880k", 1200000 -> "1.2M": a token count that fits a phone. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * "Claude · 10 models · ends in 4f2a", or "LM Studio · qwen3-8b · lm.example.com" for a provider that doesn't list its
 * models (#575): there the key's one model is the only one.
 */
function describe(key: AiKeySummary): string {
  const where = key.address ?? (key.last4 ? `ends in ${key.last4}` : null);
  const models = key.modelCount ? count(key.modelCount, 'model', 'models') : key.model;
  return [key.kindLabel, models, where].filter(Boolean).join(' · ');
}

type Lent = AiKeySummary['lentTo'][number];

/** Bots running on a key, across the universes it is lent to. */
const botsOn = (key: AiKeySummary) => key.lentTo.reduce((total, lent) => total + lent.bots.length, 0);

/** The names of a few bots: "Sam", "Guide and Nora", "Guide, Nora and Sam". */
function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** What revoking does to the bots on a key, in the mock's words: who moves, who is told, that adding it again won't move them back. */
function revokeEffect(key: AiKeySummary): string {
  const lines = key.lentTo
    .filter((lent) => lent.bots.length > 0)
    .map((lent) => {
      const bots = names(lent.bots.map((bot) => bot.name));
      return `${bots} in ${lent.universeName} ${lent.bots.length === 1 ? 'moves' : 'move'} to Universe AI${
        lent.ownedByYou ? '' : `, and the owner of ${lent.universeName} is told`
      }.`;
    });
  if (lines.length === 0) return '';
  const all = key.lentTo.flatMap((lent) => lent.bots.map((bot) => bot.name));
  return ` ${lines.join(' ')} Adding the key again later does not move ${names(all)} back.`;
}

/** The Danger zone's line under Revoke. */
function dangerLine(key: AiKeySummary): string {
  const bots = botsOn(key);
  if (bots === 0) return 'Deletes it everywhere. No bot runs on it now.';
  const told = key.lentTo.some((lent) => lent.bots.length > 0 && !lent.ownedByYou);
  return `Deletes it everywhere. ${bots === 1 ? 'Its bot moves' : `Its ${bots} bots move`} to Universe AI${told ? ' and each universe owner is told' : ''}.`;
}

/** Working or Down, as a small pill (green dot, or amber for Down). */
function StatusPill({ down }: { down: boolean }) {
  return down ? (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[rgb(245_196_81/0.55)] px-2.5 text-[11px] font-semibold text-[#F5C451]" data-testid="ai-key-status">
      <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#F5C451]" />
      Down
    </span>
  ) : (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/[.16] px-2.5 text-[11px] font-semibold" data-testid="ai-key-status">
      <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
      Working
    </span>
  );
}

const DOWN_PHRASE = {
  stopped: 'stopped answering',
  rejected: 'didn’t accept the key',
  errors: 'kept failing',
  credit: 'is out of credit',
  model: 'no longer has the model',
} as const;

/** "2:14 PM", or "Oct 18, 2:14 PM" when it was not today. */
function sinceText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The sentence under a Down key, in the mock's words: since when, why, what its bots do meanwhile, and the 5-minute recheck. */
function downText(key: AiKeySummary): string {
  const subject = key.address ?? key.kindLabel;
  const phrase = DOWN_PHRASE[key.downReason ?? 'stopped'];
  const bots = key.lentTo.flatMap((lent) => lent.bots.map((bot) => bot.name));
  const one = bots.length === 1;
  const own = key.address !== null;
  const meanwhile =
    bots.length === 0
      ? ''
      : key.ifDown === 'stop'
        ? ` ${names(bots)} ${one ? 'rests' : 'rest'} until it’s back.`
        : ` ${names(bots)} ${one ? 'replies' : 'reply'} on Universe AI until it’s back${own ? `, so ${one ? 'its' : 'their'} conversations leave your computer meanwhile` : ''}.`;
  return `Down since ${sinceText(key.downSince ?? new Date().toISOString())}: ${subject} ${phrase}.${meanwhile} Universe checks again, at most every 5 minutes, whenever a bot needs it, and switches back as soon as the key answers.`;
}

/** The line under "If this is down", for the choice that is picked. */
function ifDownHelp(key: AiKeySummary): string {
  if (key.ifDown === 'stop') return 'Bots rest until it’s back. Visitors see one line saying so, and nothing goes to another AI.';
  return key.address !== null
    ? 'Bots keep replying on Universe AI until it’s back, so their conversations leave your computer meanwhile. Pick Stop replying to keep them only on yours.'
    : 'Bots keep replying on Universe AI until it’s back.';
}

/**
 * AI keys (#374): the keys you added so your own bots can run on your own AI, hosted or on your own computer. The key
 * itself is never shown, only its last four characters.
 */
export default function AiKeysPage() {
  const { result, retry, update } = useAiKeys();
  // The key whose limits sheet is open (#666), by id, so the sheet shows its limits as just saved
  const [limitsFor, setLimitsFor] = useState<string | null>(null);
  const saveKeyLimit = useSaveKeyLimit();
  const { addToast } = useToast();
  const [revoking, setRevoking] = useState<AiKeySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lending, setLending] = useState<{ key: AiKeySummary; universeId?: string } | null>(null);
  const [editing, setEditing] = useState<AiKeySummary | null>(null);
  const [pulling, setPulling] = useState<{ key: AiKeySummary; lent: Lent } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  async function revoke(key: AiKeySummary) {
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
      // Already gone (revoked on another device): the list is right to drop it.
      if (!response.ok && response.status !== 404) throw new AiKeyFailure('That didn’t work. Try again.');
      update((keys) => keys.filter((entry) => entry.id !== key.id));
      setRevoking(null);
      addToast({ description: `${key.name} revoked`, variant: 'success', duration: 2500 });
    } catch (error) {
      setFailure(aiKeyFailureText(error));
    } finally {
      setBusy(false);
    }
  }

  async function pull(key: AiKeySummary, lent: Lent) {
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(key.id)}/lend/${encodeURIComponent(lent.universeId)}`, { method: 'DELETE' });
      // Already pulled (on another device): the list is right to drop it.
      if (!response.ok && response.status !== 404) throw new AiKeyFailure('That didn’t work. Try again.');
      retry();
      setPulling(null);
      addToast({ description: `${key.name} pulled from ${lent.universeName}`, variant: 'success', duration: 2500 });
    } catch (error) {
      const message = aiKeyFailureText(error);
      // With no bots on it there is no sheet open to show the message in
      if (lent.bots.length > 0) setFailure(message);
      else addToast({ description: message, variant: 'error', duration: 4000 });
    } finally {
      setBusy(false);
    }
  }

  async function checkNow(key: AiKeySummary) {
    setChecking(key.id);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(key.id)}/check`, { method: 'POST' });
      const body = (await response.json().catch(() => null)) as { status?: string; message?: string; error?: string } | null;
      if (!response.ok) throw new AiKeyFailure(aiKeyError(response.status, body?.error));
      retry();
      addToast(
        body?.status === 'working'
          ? { description: `${key.name} is working again`, variant: 'success', duration: 2500 }
          : { description: body?.message || `${key.name} is still down`, variant: 'error', duration: 4000 },
      );
    } catch (error) {
      addToast({ description: aiKeyFailureText(error), variant: 'error', duration: 4000 });
    } finally {
      setChecking(null);
    }
  }

  async function chooseIfDown(key: AiKeySummary, ifDown: AiKeySummary['ifDown']) {
    setSaving(key.id);
    const before = key.ifDown;
    update((list) => list.map((entry) => (entry.id === key.id ? { ...entry, ifDown } : entry)));
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(key.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ifDown }),
      });
      if (!response.ok) throw new AiKeyFailure('That didn’t save. Try again.');
    } catch (error) {
      update((list) => list.map((entry) => (entry.id === key.id ? { ...entry, ifDown: before } : entry)));
      addToast({ description: aiKeyFailureText(error), variant: 'error', duration: 4000 });
    } finally {
      setSaving(null);
    }
  }

  const keys = result.status === 'ready' ? result.items : [];

  return (
    <div className="grid gap-6" data-testid="ai-keys-page">
      <PageHeader icon={<KeyRound size={30} aria-hidden="true" />} title="AI keys">
        <p className="max-w-[60ch] text-[15px] text-muted-foreground">
          Your own AI, hosted or on your own computer. Bots you make can run on it.
        </p>
        <Button asChild className="h-11 w-fit px-5">
          <Link href="/admin/you/ai-keys/new">
            <Plus aria-hidden="true" />
            Add a key
          </Link>
        </Button>
      </PageHeader>

      {result.status === 'loading' && <LoadingRows label="your AI keys" rows={2} />}
      {result.status === 'error' && <LoadError label="your AI keys" retry={retry} />}

      {result.status === 'ready' && keys.length === 0 && (
        <p className="rounded-2xl border border-foreground/10 bg-foreground/[.03] p-4 text-[15px] text-muted-foreground" data-testid="ai-keys-empty">
          You haven’t added a key yet. Only you can see the keys you add.
        </p>
      )}

      {keys.map((key) => (
        <article
          key={key.id}
          className={`grid gap-4 rounded-2xl border bg-foreground/[.03] p-4 ${key.status === 'down' ? 'border-[rgb(245_196_81/0.55)]' : 'border-foreground/10'}`}
          data-testid="ai-key"
        >
          <header className="grid gap-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <ProviderLogo info={key.kind ? kindInfo(key.kind) : undefined} />
              <h2 className="orbit-display text-lg font-bold [overflow-wrap:anywhere]">{key.name}</h2>
              <StatusPill down={key.status === 'down'} />
            </div>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{describe(key)}</p>
          </header>
          {(key.modelCount ?? 0) <= 1 && key.caps?.tools === false && (
            <p className="text-sm text-[#F5C451]" data-testid="ai-key-no-tools">
              {NO_TOOLS}
            </p>
          )}
          {key.status === 'down' && (
            <p className="text-[15px] leading-snug text-muted-foreground" data-testid="ai-key-down-text">
              {downText(key)}
            </p>
          )}
          <div className="grid gap-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">This month</h3>
            <p className="text-[15px]">
              {key.month.replies.toLocaleString()} {key.month.replies === 1 ? 'reply' : 'replies'} · {compact(key.month.tokens)} tokens
            </p>
          </div>
          <div className="grid gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Lent to</h3>
            {key.lentTo.length === 0 && <p className="text-[15px] text-muted-foreground">No universe yet. Only you can see this key.</p>}
            {key.lentTo.map((lent) => (
              <div key={lent.universeId} className="grid gap-2 rounded-2xl border border-foreground/10 bg-foreground/[.04] p-3" data-testid="ai-key-lent">
                <div className="flex items-center gap-2">
                  <strong className="flex min-w-0 flex-1 items-center gap-2 text-[15px]">
                    <Planet size={16} aria-hidden="true" className="shrink-0 text-[rgba(167,139,250,.9)]" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{lent.universeName}</span>
                  </strong>
                  <button
                    type="button"
                    aria-label={`Pull ${key.name} from ${lent.universeName}`}
                    disabled={busy}
                    onClick={() => {
                      setFailure(null);
                      if (lent.bots.length > 0) setPulling({ key, lent });
                      else void pull(key, lent);
                    }}
                    className="orbit-press -my-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-foreground/[0.08]"
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
                <div className="flex items-center gap-2 rounded-xl bg-foreground/[.04] py-1 pl-3 pr-1">
                  <span className="min-w-0 flex-1 text-[13px]" data-testid="lent-models">
                    <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Models</span>
                    <span className="block [overflow-wrap:anywhere]">{lent.models ? `Only ${lent.models.join(', ')}` : 'All models'}</span>
                  </span>
                  <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => setLending({ key, universeId: lent.universeId })} data-testid="lent-edit-models" aria-label={`Change the models bots in ${lent.universeName} may use`}>
                    Change
                  </Button>
                </div>
                {lent.bots.map((bot) => (
                  <span key={bot.id} className="flex items-start gap-2 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
                    <Bot size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span className="min-w-0">{[bot.name, bot.model, count(bot.replies, 'reply', 'replies')].filter(Boolean).join(' · ')}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="grid gap-2" data-testid="ai-key-limits">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Limits</h3>
            <div className="flex items-center gap-2 rounded-xl bg-foreground/[.04] py-1 pl-3 pr-1">
              <span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
                {keyLimitsLine(key.limits)}
              </span>
              <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => setLimitsFor(key.id)} data-testid="ai-key-limits-change">
                Change
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <h3 id={`if-down-${key.id}`} className="text-xs font-bold uppercase tracking-wider text-muted-foreground">If this is down</h3>
            <Segmented
              aria-labelledby={`if-down-${key.id}`}
              value={key.ifDown}
              onChange={(value) => void chooseIfDown(key, value)}
              options={[
                { value: 'stop', label: 'Stop replying', disabled: saving === key.id },
                { value: 'universe-ai', label: 'Use Universe AI', disabled: saving === key.id },
              ]}
            />
            <p className="text-sm text-muted-foreground" data-testid="ai-key-if-down-help">{ifDownHelp(key)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {key.status === 'down' && (
              <Button variant="outline" className="h-11 w-fit px-5" disabled={checking === key.id} onClick={() => void checkNow(key)}>
                <RefreshCw aria-hidden="true" className={checking === key.id ? 'animate-spin' : undefined} />
                {checking === key.id ? 'Checking…' : 'Check now'}
              </Button>
            )}
            <Button variant="outline" className="h-11 w-fit px-5" onClick={() => setLending({ key })}>
              <Plus aria-hidden="true" />
              Lend to a universe
            </Button>
            {key.address !== null && (
              <Button variant="outline" className="h-11 w-fit px-5" onClick={() => setEditing(key)}>
                <Globe aria-hidden="true" />
                Change address
              </Button>
            )}
          </div>
        </article>
      ))}

      {(() => {
        const key = keys.find((entry) => entry.id === limitsFor) ?? null;
        return (
          <FormSheet open={key !== null} onOpenChange={(open) => !open && setLimitsFor(null)} title={key ? `Limits for ${key.name}` : 'Limits'} description="For bots that run on this key. Each bot’s editors can lower them for that bot.">
            {key && (
              <LimitGroup
                title="Replies"
                limits={replyLimits(key.limits)}
                onChange={async (id, value) => {
                  const saved = await saveKeyLimit(key.id, id, value);
                  if (saved) update((all) => all.map((entry) => (entry.id === key.id ? { ...entry, limits: saved } : entry)));
                  return saved !== null;
                }}
              />
            )}
            <div className="flex justify-end">
              <Button className="h-11 px-5" onClick={() => setLimitsFor(null)}>
                Done
              </Button>
            </div>
          </FormSheet>
        );
      })()}

      {keys.length > 0 && (
        <section className="grid gap-3 border-t border-foreground/10 pt-6" aria-labelledby="ai-keys-danger">
          <h2 id="ai-keys-danger" className="orbit-display text-lg font-bold text-[#fca5a5]">Danger zone</h2>
          {keys.map((key) => (
            <div key={key.id} className="grid gap-3 rounded-2xl border border-[rgba(248,113,113,.4)] bg-foreground/[.03] p-4">
              <div className="min-w-0">
                <strong className="block text-[17px] [overflow-wrap:anywhere]">Revoke {key.name}</strong>
                <p className="mt-1 text-sm text-muted-foreground">{dangerLine(key)}</p>
              </div>
              <Button
                variant="outline"
                className="h-11 w-fit border-[rgba(248,113,113,.4)] px-5 text-[#fca5a5] hover:text-[#fca5a5]"
                onClick={() => {
                  setFailure(null);
                  setRevoking(key);
                }}
              >
                <Trash2 aria-hidden="true" />
                Revoke
              </Button>
            </div>
          ))}
        </section>
      )}

      <FormSheet
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
        title={revoking ? `Revoke ${revoking.name}?` : 'Revoke key?'}
      >
        <p className="text-sm text-muted-foreground">
          It stops working everywhere at once and is deleted from Universe.{revoking ? revokeEffect(revoking) : ''}
        </p>
        {failure && (
          <p role="alert" className="text-sm text-[#fca5a5]">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={() => setRevoking(null)}>
            Cancel
          </Button>
          <Button variant="destructive" className="h-11 px-5" disabled={busy} onClick={() => revoking && void revoke(revoking)}>
            {busy ? 'Revoking…' : 'Revoke'}
          </Button>
        </div>
      </FormSheet>

      <FormSheet
        open={pulling !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPulling(null);
        }}
        title={pulling ? `Pull ${pulling.key.name} from ${pulling.lent.universeName}?` : 'Pull key?'}
      >
        <p className="text-sm text-muted-foreground">
          {pulling &&
            `${names(pulling.lent.bots.map((bot) => bot.name))} ${pulling.lent.bots.length === 1 ? 'moves' : 'move'} to Universe AI${
              pulling.lent.ownedByYou ? '' : `, and the owner of ${pulling.lent.universeName} is told`
            }. Lending it again later does not move ${pulling.lent.bots.length === 1 ? 'it' : 'them'} back.`}
        </p>
        {failure && (
          <p role="alert" className="text-sm text-[#fca5a5]">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={() => setPulling(null)}>
            Cancel
          </Button>
          <Button variant="destructive" className="h-11 px-5" disabled={busy} onClick={() => pulling && void pull(pulling.key, pulling.lent)}>
            {busy ? 'Pulling…' : 'Pull'}
          </Button>
        </div>
      </FormSheet>

      <EditKeySheet
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={(key) => {
          setEditing(null);
          retry();
          addToast({ description: `${key.name} now uses the new address`, variant: 'success', duration: 2500 });
        }}
      />

      <LendSheet
        keyToLend={lending?.key ?? null}
        editing={lending?.universeId}
        onClose={() => setLending(null)}
        onLent={(key, universeName) => {
          setLending(null);
          retry();
          addToast({ description: lending?.universeId ? `Models for ${universeName} saved` : `${key.name} lent to ${universeName}`, variant: 'success', duration: 2500 });
        }}
      />
    </div>
  );
}

interface LendableUniverse {
  id: string;
  name: string;
  access: 'owner' | 'manage';
}

/**
 * Lend a key (#374), or change what a lend allows: the universes where you can manage bots, then the models bots there
 * may use (all of them, or only the ones ticked). Lending moves no bot.
 */
function LendSheet({
  keyToLend,
  editing,
  onClose,
  onLent,
}: {
  keyToLend: AiKeySummary | null;
  /** The universe whose models are being changed; the universe list is left out. */
  editing?: string;
  onClose: () => void;
  onLent: (key: AiKeySummary, universeName: string) => void;
}) {
  const [universes, setUniverses] = useState<LendableUniverse[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [limit, setLimit] = useState<'all' | 'only'>('all');
  const [only, setOnly] = useState<string[]>([]);
  const [models, setModels] = useState<ModelList>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = keyToLend !== null;
  const lentIds = new Set(keyToLend?.lentTo.map((lent) => lent.universeId));
  const lent = keyToLend?.lentTo.find((entry) => entry.universeId === editing);

  useEffect(() => {
    if (!open || !keyToLend) return;
    let cancelled = false;
    setUniverses(null);
    setModels({ status: 'loading' });
    setLoadFailed(false);
    setFailure(null);
    setLimit(lent?.models ? 'only' : 'all');
    setOnly(lent?.models ?? []);
    // Changing one lend's models needs no universe list: that universe is the one saved
    setPicked(editing ?? null);
    if (!editing) {
      authenticatedFetch('/api/me/ai-keys/universes')
        .then(async (response) => {
          if (!response.ok) throw new Error('failed');
          const data = (await response.json()) as { universes?: LendableUniverse[] };
          if (cancelled) return;
          const list = data.universes ?? [];
          setUniverses(list);
          setPicked(list.find((universe) => !lentIds.has(universe.id))?.id ?? null);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
    }
    // The key's models, for "Only these"
    authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(keyToLend.id)}/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; models?: string[]; facts?: Record<string, { tools?: boolean; vision?: boolean }>; message?: string; noList?: boolean };
        if (cancelled) return;
        if (data.ok && Array.isArray(data.models)) {
          const listed = data.models;
          setModels({ status: 'ready', models: listed, facts: data.facts ?? {} });
          // A model the provider no longer has can't be ticked off, so it is dropped from the ones kept
          setOnly((kept) => kept.filter((id) => listed.includes(id)));
        }
        else if (data.noList) setModels({ status: 'typed' });
        else setModels({ status: 'failed', message: data.message || 'Couldn’t load the models. Close this and try again.' });
      })
      .catch(() => {
        if (!cancelled) setModels({ status: 'failed', message: 'Couldn’t load the models. Close this and try again.' });
      });
    return () => {
      cancelled = true;
    };
    // The lists are read once each time the sheet opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyToLend?.id, editing]);

  // A provider that doesn't list its models has only the key's one model: nothing to limit, whatever was picked while its
  // list was still loading
  const canLimit = models.status !== 'typed';
  const limited = canLimit && limit === 'only';

  async function lend() {
    if (!keyToLend || !picked || (!editing && !universes)) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(keyToLend.id)}/lend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A new lend with All models sends none: all is what a new lend gets. A change of an existing lend always says which.
        // A change says so, so a lend removed meanwhile (in another tab, or by the universe) is not made again
        body: JSON.stringify({ universeId: picked, ...(limited ? { models: only } : editing ? { models: null } : {}), ...(editing ? { existing: true } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new AiKeyFailure(aiKeyError(response.status, body?.error));
      }
      onLent(keyToLend, lent?.universeName ?? universes?.find((universe) => universe.id === picked)?.name ?? 'the universe');
    } catch (error) {
      setFailure(aiKeyFailureText(error));
    } finally {
      setBusy(false);
    }
  }

  // Bots there on a model that is no longer allowed move to the first allowed one, in the provider's order, that the provider
  // doesn't say calls no tools (a bot's replies always offer them), the same pick the save makes
  const kept = models.status === 'ready' ? models.models.filter((id) => only.includes(id)) : [];
  const firstKept = models.status === 'ready' ? (kept.find((id) => models.facts[id]?.tools !== false) ?? kept[0]) : undefined;
  const moving = limited && firstKept && lent ? lent.bots.filter((bot) => bot.model !== null && !only.includes(bot.model)) : [];
  const provider = keyToLend?.kindLabel ?? 'the provider';

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={keyToLend ? (lent ? `Models for ${lent.universeName}` : `Lend ${keyToLend.name}`) : 'Lend key'}
    >
      {!editing && (
        <>
          <p className="text-sm text-muted-foreground">
            Universes where you can manage bots. Lending moves no bot: in a bot you made there, pick this key under Runs on.
          </p>
          {universes === null && !loadFailed && <p className="text-sm text-muted-foreground">Loading your universes…</p>}
          {loadFailed && (
            <p role="alert" className="text-sm text-[#fca5a5]">
              Couldn’t load your universes. Close this and try again.
            </p>
          )}
          {universes !== null && universes.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="lend-none">
              You can’t manage bots in any universe yet.
            </p>
          )}
          {universes !== null && universes.length > 0 && (
            <div role="radiogroup" aria-label="Universe" className="grid gap-2">
              {universes.map((universe) => {
                const already = lentIds.has(universe.id);
                return (
                  <PickCard
                    key={universe.id}
                    role="radio"
                    picked={picked === universe.id}
                    disabled={already}
                    onClick={() => setPicked(universe.id)}
                    className="flex-row-reverse"
                    indicator={<Radio checked={picked === universe.id} />}
                    title={
                      <span className="flex items-center gap-2">
                        <Planet size={16} aria-hidden="true" className="shrink-0 text-[rgba(167,139,250,.9)]" />
                        {universe.name}
                      </span>
                    }
                    description={already ? 'Already lent' : universe.access === 'owner' ? 'You own it' : 'You have Manage bots here'}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
      {canLimit && (
        <section className="grid gap-2" aria-labelledby="lend-models" data-testid="lend-models">
          <h3 id="lend-models" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Models bots there may use</h3>
          <Segmented
            aria-labelledby="lend-models"
            value={limit}
            onChange={setLimit}
            options={[
              { value: 'all', label: 'All models' },
              { value: 'only', label: 'Only these' },
            ]}
          />
          <p className="text-sm text-muted-foreground">
            {limit === 'all'
              ? `Every model ${provider} has, including new ones it adds later. Each bot picks one on its page.`
              : `Bots there may only pick the models you tick. New ones ${provider} adds later are not added.`}
          </p>
          {limit === 'only' && models.status === 'ready' && (
            <ModelPicker models={models.models} facts={models.facts} mode="many" picked={only} onChange={setOnly} label="Models bots there may use" />
          )}
          {limit === 'only' && models.status === 'loading' && <p className="text-sm text-muted-foreground">Loading the models…</p>}
          {limit === 'only' && models.status === 'failed' && (
            <p role="alert" className="text-sm text-[#fca5a5]">
              {models.message}
            </p>
          )}
          {moving.length > 0 && (
            <p className="text-sm text-[#F5C451]" data-testid="lend-moving">
              {moving.map((bot) => `${bot.name} uses ${bot.model}`).join('. ')}. {moving.length === 1 ? 'It moves' : 'They move'} to {firstKept}
              {lent && !lent.ownedByYou ? `, and the owner of ${lent.universeName} is told` : ''}.
            </p>
          )}
        </section>
      )}
      {!canLimit && editing && (
        <p className="text-sm text-muted-foreground" data-testid="lend-one-model">
          {keyToLend?.kindLabel} doesn’t share a list of its models, so bots there use {keyToLend?.model ?? 'its one model'}. There is nothing to limit.
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-[#fca5a5]">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button className="h-11 px-5" disabled={busy || !picked || (limited && only.length === 0)} onClick={() => void lend()}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Lend'}
        </Button>
      </div>
    </FormSheet>
  );
}

/** More models than this and a search box appears; only this many are shown at once. */
const SEARCH_FROM = 8;
const SHOWN = 30;

type ModelList = { status: 'loading' } | { status: 'ready'; models: string[]; facts: Record<string, { tools?: boolean; vision?: boolean }> } | { status: 'failed'; message: string } | { status: 'typed' };

const NO_TOOLS = 'This model has no Tools. Bots on it can still chat.';

/**
 * Change a saved key's address (#374). The key stays the same key, so it stays lent and its bots stay on it: a free
 * tunnel gets a new address each time it restarts. Nothing is saved until the new address answers. When it doesn't have
 * the model the key is checked with, the models it does have are shown to pick a new one. The key itself is never shown
 * or asked for again. Each bot picks its own model (#575), so there is no key model to change.
 */
function EditKeySheet({
  target,
  onClose,
  onSaved,
}: {
  target: AiKeySummary | null;
  onClose: () => void;
  onSaved: (key: AiKeySummary) => void;
}) {
  const [address, setAddress] = useState('');
  const [models, setModels] = useState<ModelList>({ status: 'loading' });
  const [model, setModel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The new address answered but doesn't have the saved model: the models it does have are shown to pick from
  const [pickOnNew, setPickOnNew] = useState(false);
  // Only the newest model load may answer: a slow one for a sheet that was closed, reopened or retried is dropped
  const latestLoad = useRef(0);
  const open = target !== null;
  const keyId = target?.id;

  useEffect(() => {
    setAddress('');
    setPickOnNew(false);
    setModel(null);
    setSearch('');
    setFailure(null);
    setModels({ status: 'loading' });
    // Closing or switching the sheet drops any load still on its way, including one started by save()
    return () => {
      latestLoad.current += 1;
    };
  }, [keyId]);

  /** The models the key's provider lists, at its saved address or a new one being tried */
  async function loadModels(id: string, newAddress: string) {
    const mine = ++latestLoad.current;
    const cancelled = () => mine !== latestLoad.current;
    setModels({ status: 'loading' });
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(id)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: newAddress }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; models?: string[]; facts?: Record<string, { tools?: boolean; vision?: boolean }>; message?: string; noList?: boolean };
      if (cancelled()) return;
      if (data.ok && Array.isArray(data.models)) setModels({ status: 'ready', models: data.models, facts: data.facts ?? {} });
      else if (data.noList) setModels({ status: 'typed' });
      else setModels({ status: 'failed', message: data.message || 'Couldn’t load the models. Try again.' });
    } catch {
      if (!cancelled()) setModels({ status: 'failed', message: 'Couldn’t load the models. Try again.' });
    }
  }

  const visible = useMemo(() => {
    if (models.status !== 'ready') return [];
    const needle = search.trim().toLowerCase();
    return models.models.filter((id) => !needle || id.toLowerCase().includes(needle)).slice(0, SHOWN);
  }, [models, search]);

  async function save() {
    if (!target) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickOnNew ? { address: address.trim(), model: model?.trim() } : { address: address.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (!pickOnNew && body?.code === 'model-missing') {
          // Offer the models the new address does have, to pick one and save both together
          setPickOnNew(true);
          setModel(null);
          setSearch('');
          setFailure(body.error || null);
          void loadModels(target.id, address.trim());
          return;
        }
        throw new AiKeyFailure(aiKeyError(response.status, body?.error));
      }
      onSaved(target);
    } catch (error) {
      setFailure(aiKeyFailureText(error));
    } finally {
      setBusy(false);
    }
  }

  const ready = pickOnNew ? model !== null : address.trim() !== '';
  const shared = models.status === 'ready' ? sharedCaps(models.models, models.facts) : { tools: false, vision: false };

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={target ? `Change address of ${target.name}` : 'Change address'}
    >
      <p className="text-sm text-muted-foreground">It is checked before it is saved. The key stays lent and its bots stay on it.</p>
      {target && (
        <div className="grid gap-1.5">
          <Label htmlFor="ai-key-new-address">New address</Label>
          <Input
            id="ai-key-new-address"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://lm.example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={pickOnNew}
            className="h-11 rounded-xl"
          />
          <p className="text-[13px] text-muted-foreground">Now: {target.address}. Must start with https:// and be reachable from the internet.</p>
        </div>
      )}
      {pickOnNew && (
        <div className="grid gap-3" aria-live="polite">
          {models.status === 'loading' && <p className="text-sm text-muted-foreground">Loading the models…</p>}
          {models.status === 'failed' && (
            <p role="alert" className="text-sm text-[#fca5a5]">
              {models.message}
            </p>
          )}
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
              <p className="text-[13px] text-muted-foreground">
                {target?.name} comes from a provider that doesn’t share a list of its models. Now: {target?.model ?? 'no model'}. The new name is checked with one tiny reply.
              </p>
            </div>
          )}
          {models.status === 'ready' && (
            <>
              {(shared.tools || shared.vision) && (
                <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground [&>span]:mt-0 [&>span]:text-sm">
                  All {models.models.length} models have <ModelCaps facts={{ tools: shared.tools || undefined, vision: shared.vision || undefined }} />
                </p>
              )}
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
                  <PickCard key={id} role="radio" picked={model === id} onClick={() => setModel(id)} indicator={<Radio checked={model === id} />} title={id} description={<ModelCaps facts={models.facts[id]} skip={shared} />} className="[&_span.block]:break-all" />
                ))}
                {visible.length === 0 && <p className="text-[13px] text-muted-foreground">No model matches that.</p>}
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
      {failure && (
        <p role="alert" className="text-sm text-[#fca5a5]">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button className="h-11 px-5" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
        </Button>
      </div>
    </FormSheet>
  );
}
