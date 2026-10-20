'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, Globe, KeyRound, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { authenticatedFetch } from '@/lib/client-auth';
import type { AiKeySummary } from '@/lib/ai-keys';
import { LoadError, LoadingRows, PageHeader, count } from '../../components/ds';
import { FormSheet } from '../../components/form-sheet';
import { Planet } from '../../components/ds/planet-icon';
import { PickCard, Radio, Segmented } from '@/components/ui/choice';
import { aiKeyError, useAiKeys } from '../../hooks/use-ai-keys';

/** 880000 -> "880k", 1200000 -> "1.2M": a token count that fits a phone. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "LM Studio · qwen3-8b · lm.example.com", or "DeepSeek · deepseek-v4-flash · ends in 4f2a". */
function describe(key: AiKeySummary): string {
  const where = key.address ?? (key.last4 ? `ends in ${key.last4}` : null);
  return [key.kindLabel, key.model, where].filter(Boolean).join(' · ');
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
  return `Down since ${sinceText(key.downSince ?? new Date().toISOString())}: ${subject} ${phrase}.${meanwhile} Universe checks every 5 minutes and switches back by itself.`;
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
  const { addToast } = useToast();
  const [revoking, setRevoking] = useState<AiKeySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lending, setLending] = useState<AiKeySummary | null>(null);
  const [editing, setEditing] = useState<{ key: AiKeySummary; what: 'address' | 'model' } | null>(null);
  const [pulling, setPulling] = useState<{ key: AiKeySummary; lent: Lent } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  async function revoke(key: AiKeySummary) {
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
      // Already gone (revoked on another device): the list is right to drop it.
      if (!response.ok && response.status !== 404) throw new Error('That didn’t work. Try again.');
      update((keys) => keys.filter((entry) => entry.id !== key.id));
      setRevoking(null);
      addToast({ description: `${key.name} revoked`, variant: 'success', duration: 2500 });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That didn’t work. Try again.');
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
      if (!response.ok && response.status !== 404) throw new Error('That didn’t work. Try again.');
      retry();
      setPulling(null);
      addToast({ description: `${key.name} pulled from ${lent.universeName}`, variant: 'success', duration: 2500 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'That didn’t work. Try again.';
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
      if (!response.ok) throw new Error(aiKeyError(response.status, body?.error));
      retry();
      addToast(
        body?.status === 'working'
          ? { description: `${key.name} is working again`, variant: 'success', duration: 2500 }
          : { description: body?.message || `${key.name} is still down`, variant: 'error', duration: 4000 },
      );
    } catch (error) {
      addToast({ description: error instanceof Error ? error.message : 'That didn’t work. Try again.', variant: 'error', duration: 4000 });
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
      if (!response.ok) throw new Error('That didn’t save. Try again.');
    } catch (error) {
      update((list) => list.map((entry) => (entry.id === key.id ? { ...entry, ifDown: before } : entry)));
      addToast({ description: error instanceof Error ? error.message : 'That didn’t save. Try again.', variant: 'error', duration: 4000 });
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
              <h2 className="orbit-display text-lg font-bold [overflow-wrap:anywhere]">{key.name}</h2>
              <StatusPill down={key.status === 'down'} />
            </div>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{describe(key)}</p>
          </header>
          {key.caps?.tools === false && (
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
              <div key={lent.universeId} className="flex items-center gap-3 rounded-2xl border border-foreground/10 bg-foreground/[.04] p-3" data-testid="ai-key-lent">
                <div className="grid min-w-0 flex-1 gap-1">
                  <strong className="flex items-center gap-2 text-[15px]">
                    <Planet size={16} aria-hidden="true" className="shrink-0 text-[rgba(167,139,250,.9)]" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{lent.universeName}</span>
                  </strong>
                  {lent.bots.map((bot) => (
                    <span key={bot.id} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Bot size={14} aria-hidden="true" className="shrink-0" />
                      {bot.name} · {count(bot.replies, 'reply', 'replies')}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label={`Pull ${key.name} from ${lent.universeName}`}
                  disabled={busy}
                  onClick={() => {
                    setFailure(null);
                    if (lent.bots.length > 0) setPulling({ key, lent });
                    else void pull(key, lent);
                  }}
                  className="orbit-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-foreground/[0.08]"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            ))}
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
            <Button variant="outline" className="h-11 w-fit px-5" onClick={() => setLending(key)}>
              <Plus aria-hidden="true" />
              Lend to a universe
            </Button>
            {key.address !== null && (
              <Button variant="outline" className="h-11 w-fit px-5" onClick={() => setEditing({ key, what: 'address' })}>
                <Globe aria-hidden="true" />
                Change address
              </Button>
            )}
            <Button variant="outline" className="h-11 w-fit px-5" onClick={() => setEditing({ key, what: 'model' })}>
              <Pencil aria-hidden="true" />
              Change model
            </Button>
          </div>
        </article>
      ))}

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
        onSaved={(key, what) => {
          setEditing(null);
          retry();
          addToast({ description: `${key.name} now uses the new ${what}`, variant: 'success', duration: 2500 });
        }}
      />

      <LendSheet
        keyToLend={lending}
        onClose={() => setLending(null)}
        onLent={(key, universeName) => {
          setLending(null);
          retry();
          addToast({ description: `${key.name} lent to ${universeName}`, variant: 'success', duration: 2500 });
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

/** Lend a key (#374): the universes where you can manage bots. Lending moves no bot. */
function LendSheet({
  keyToLend,
  onClose,
  onLent,
}: {
  keyToLend: AiKeySummary | null;
  onClose: () => void;
  onLent: (key: AiKeySummary, universeName: string) => void;
}) {
  const [universes, setUniverses] = useState<LendableUniverse[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = keyToLend !== null;
  const lentIds = new Set(keyToLend?.lentTo.map((lent) => lent.universeId));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setUniverses(null);
    setLoadFailed(false);
    setFailure(null);
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
    return () => {
      cancelled = true;
    };
    // The list is read once each time the sheet opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyToLend?.id]);

  async function lend() {
    if (!keyToLend || !picked || !universes) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(keyToLend.id)}/lend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ universeId: picked }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(aiKeyError(response.status, body?.error));
      }
      onLent(keyToLend, universes.find((universe) => universe.id === picked)?.name ?? 'the universe');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={keyToLend ? `Lend ${keyToLend.name}` : 'Lend key'}
    >
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
      {failure && (
        <p role="alert" className="text-sm text-[#fca5a5]">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button className="h-11 px-5" disabled={busy || !picked} onClick={() => void lend()}>
          {busy ? 'Lending…' : 'Lend'}
        </Button>
      </div>
    </FormSheet>
  );
}

/** More models than this and a search box appears; only this many are shown at once. */
const SEARCH_FROM = 8;
const SHOWN = 30;

type ModelList = { status: 'loading' } | { status: 'ready'; models: string[]; facts: Record<string, { tools?: boolean; vision?: boolean }> } | { status: 'failed'; message: string };

const NO_TOOLS = 'This model has no Tools. Bots on it can still chat.';

/**
 * Change a saved key's address or model (#374). The key stays the same key, so it stays lent and its bots stay on it:
 * a free tunnel gets a new address each time it restarts. Nothing is saved until the new address answers and the model
 * gives one tiny reply. The key itself is never shown or asked for again.
 */
function EditKeySheet({
  target,
  onClose,
  onSaved,
}: {
  target: { key: AiKeySummary; what: 'address' | 'model' } | null;
  onClose: () => void;
  onSaved: (key: AiKeySummary, what: 'address' | 'model') => void;
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
  const what = target?.what;
  const keyId = target?.key.id;

  useEffect(() => {
    setAddress('');
    setPickOnNew(false);
    setModel(null);
    setSearch('');
    setFailure(null);
    setModels({ status: 'loading' });
    // Closing or switching the sheet drops any load still on its way, including one started by save()
    const dropLoads = () => {
      latestLoad.current += 1;
    };
    if (!keyId || what !== 'model') return dropLoads;
    void loadModels(keyId, undefined);
    return dropLoads;
  }, [keyId, what]);

  /** The models the key's provider lists, at its saved address or a new one being tried */
  async function loadModels(id: string, newAddress: string | undefined) {
    const mine = ++latestLoad.current;
    const cancelled = () => mine !== latestLoad.current;
    setModels({ status: 'loading' });
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(id)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAddress ? { address: newAddress } : {}),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; models?: string[]; facts?: Record<string, { tools?: boolean; vision?: boolean }>; message?: string };
      if (cancelled()) return;
      if (data.ok && Array.isArray(data.models)) setModels({ status: 'ready', models: data.models, facts: data.facts ?? {} });
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
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(target.key.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.what === 'address' ? (pickOnNew ? { address: address.trim(), model } : { address: address.trim() }) : { model }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (target.what === 'address' && !pickOnNew && body?.code === 'model-missing') {
          // Offer the models the new address does have, to pick one and save both together
          setPickOnNew(true);
          setModel(null);
          setSearch('');
          setFailure(body.error || null);
          void loadModels(target.key.id, address.trim());
          return;
        }
        throw new Error(aiKeyError(response.status, body?.error));
      }
      onSaved(target.key, target.what);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const picking = target?.what === 'model' || pickOnNew;
  const ready = picking ? model !== null && (pickOnNew || model !== target?.key.model) : address.trim() !== '';

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={target ? `${target.what === 'address' ? 'Change address of' : 'Change model of'} ${target.key.name}` : 'Change key'}
    >
      <p className="text-sm text-muted-foreground">
        {target?.what === 'address'
          ? 'It is checked before it is saved. The key stays lent and its bots stay on it.'
          : 'The new model is asked for one tiny reply before it is saved. The key stays lent and its bots stay on it.'}
      </p>
      {target?.what === 'address' && (
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
          <p className="text-[13px] text-muted-foreground">Now: {target.key.address}. Must start with https:// and be reachable from the internet.</p>
        </div>
      )}
      {picking && (
        <div className="grid gap-3" aria-live="polite">
          {models.status === 'loading' && <p className="text-sm text-muted-foreground">Loading the models…</p>}
          {models.status === 'failed' && (
            <p role="alert" className="text-sm text-[#fca5a5]">
              {models.message}
            </p>
          )}
          {models.status === 'ready' && (
            <>
              {!pickOnNew && <p className="text-sm text-muted-foreground">Now: {target?.key.model ?? 'no model'}</p>}
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
