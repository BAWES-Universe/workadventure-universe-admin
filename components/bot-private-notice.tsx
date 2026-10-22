'use client';

import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyCard, SectionHeader } from '@/app/admin/components/ds';
import { authenticatedFetch } from '@/lib/client-auth';

export interface BotPrivacyDetails {
  /** People the bot remembers, and when that last changed. No text. */
  people: number;
  lastUpdated: number | null;
  /** AI calls from the usage rows. */
  replies: number;
  /** Who, by name only, so one of them can be forgotten. */
  remembered?: { id: number; name: string | null; isGuest: boolean; updatedAt: number }[];
}

/** The Conversations tab of a bot whose chat telemetry is off: a notice and the count, never a transcript. */
export function BotConversationsPrivate({ replies }: { replies: number }) {
  return (
    <EmptyCard
      kind="bot"
      title="Telemetry is off for this bot"
      text={`Its chats are saved, but not shown here. ${replies.toLocaleString()} ${replies === 1 ? 'reply' : 'replies'} so far (see Usage).`}
    />
  );
}

type Target = { kind: 'everyone' } | { kind: 'person'; id: number; name: string };

/**
 * The Emotions tab of a bot whose chat telemetry is off: how many people it remembers and when that last changed,
 * with Forget for one person or everyone. What it remembers is never shown.
 */
export function BotMemoryPrivate({ botId, details, onForgotten }: { botId: string; details: BotPrivacyDetails; onForgotten: () => void }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function forget() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/bots/${encodeURIComponent(botId)}/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.kind === 'everyone' ? { everyone: true } : { memoryId: target.id }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not forget. Please try again.');
      }
      setDone(
        target.kind === 'everyone'
          ? 'Forgotten. The bot drops everyone from its memory within a few minutes.'
          : `Forgotten. The bot drops ${target.name} from its memory within a few minutes.`,
      );
      setTarget(null);
      onForgotten();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not forget. Please try again.');
      setTarget(null);
    } finally {
      setBusy(false);
    }
  }

  const people = details.remembered ?? [];
  return (
    <div className="grid min-w-0 gap-4">
      <section aria-labelledby="bot-memory-private" className="min-w-0">
        <SectionHeader id="bot-memory-private" title="Telemetry is off for this bot" />
        <div className="grid gap-3 rounded-2xl border bg-card p-4 sm:p-5">
          <p className="text-sm">
            {details.people === 0
              ? 'Remembers nobody yet.'
              : `Remembers ${details.people.toLocaleString()} ${details.people === 1 ? 'person' : 'people'}${details.lastUpdated ? `, last updated ${new Date(details.lastUpdated).toLocaleString()}` : ''}.`}
          </p>
          <p className="text-xs text-muted-foreground">
            What the bot remembers is not shown here. The bot still uses it, and it is still stored.
          </p>
          {details.people > 0 && (
            <div>
              <Button variant="outline" className="text-destructive" onClick={() => setTarget({ kind: 'everyone' })} disabled={busy}>
                Forget everyone
              </Button>
            </div>
          )}
          {done && (
            <p role="status" className="text-sm">
              {done}
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </section>

      {people.length > 0 && (
        <section aria-labelledby="bot-memory-people" className="min-w-0">
          <SectionHeader id="bot-memory-people" title="Forget one person" />
          <ul className="grid gap-2">
            {people.map((person) => {
              const name = person.name || (person.isGuest ? 'A guest' : 'Someone');
              return (
                <li key={person.id} className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-2">
                  <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                    <strong>{name}</strong>
                    {person.isGuest && <span className="text-muted-foreground"> · Guest</span>}
                    <span className="block text-xs text-muted-foreground">Last updated {new Date(person.updatedAt).toLocaleString()}</span>
                  </span>
                  <Button variant="outline" className="shrink-0 text-destructive" onClick={() => setTarget({ kind: 'person', id: person.id, name })} disabled={busy}>
                    Forget
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && !busy && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{target?.kind === 'person' ? `Forget ${target.name}?` : 'Forget everyone?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {target?.kind === 'person'
                ? `The bot will forget everything it remembers about ${target.name}: their name, facts and feelings. This can’t be undone.`
                : 'The bot will forget everything it remembers about everyone: names, facts and feelings. This can’t be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={forget} disabled={busy}>
              {busy ? 'Forgetting…' : 'Forget'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
