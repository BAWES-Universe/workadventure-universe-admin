'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bot, KeyRound, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { authenticatedFetch } from '@/lib/client-auth';
import type { AiKeySummary } from '@/lib/ai-keys';
import { LoadError, LoadingRows, PageHeader, count } from '../../components/ds';
import { FormSheet } from '../../components/form-sheet';
import { Planet } from '../../components/ds/planet-icon';
import { PickCard, Radio } from '@/components/ui/choice';
import { useAiKeys } from '../../hooks/use-ai-keys';

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
  const [pulling, setPulling] = useState<{ key: AiKeySummary; lent: Lent } | null>(null);

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
      setFailure(error instanceof Error ? error.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
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
        <article key={key.id} className="grid gap-4 rounded-2xl border border-foreground/10 bg-foreground/[.03] p-4" data-testid="ai-key">
          <header className="grid gap-1">
            <h2 className="orbit-display text-lg font-bold">{key.name}</h2>
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{describe(key)}</p>
          </header>
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
            <Button variant="outline" className="h-11 w-fit px-5" onClick={() => setLending(key)}>
              <Plus aria-hidden="true" />
              Lend to a universe
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
        throw new Error(body?.error || 'That didn’t work. Try again.');
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
