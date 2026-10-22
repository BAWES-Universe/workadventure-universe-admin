'use client';

import { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { authenticatedFetch } from '@/lib/client-auth';
import type { AiKeySummary } from '@/lib/ai-keys';
import { LoadError, LoadingRows, PageHeader } from '../../components/ds';
import { FormSheet } from '../../components/form-sheet';
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

  const keys = result.status === 'ready' ? result.items : [];

  return (
    <div className="grid gap-6" data-testid="ai-keys-page">
      <PageHeader icon={<KeyRound size={30} aria-hidden="true" />} title="AI keys">
        <p className="max-w-[60ch] text-[15px] text-muted-foreground">
          Your own AI, hosted or on your own computer. Bots you make can run on it.
        </p>
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
          <div className="grid gap-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Lent to</h3>
            <p className="text-[15px] text-muted-foreground">No universe yet. Only you can see this key.</p>
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
                <p className="mt-1 text-sm text-muted-foreground">Deletes it everywhere.</p>
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
          It stops working everywhere and can’t be brought back. You can add the same key again later.
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
    </div>
  );
}
