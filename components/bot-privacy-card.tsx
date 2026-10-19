'use client';

import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Segmented } from '@/components/ui/choice';
import { authenticatedFetch } from '@/lib/client-auth';
import type { BotPrivacyChoice } from '@/lib/bot-privacy';

export interface BotPrivacyState {
  universeHides: boolean;
  choice: BotPrivacyChoice;
  hidden: boolean;
}

/**
 * Hide bot conversations (#435) for one bot: follow the universe, hide it for this bot alone, or keep it normal. A
 * universe that hides bot conversations wins, so Normal is not offered there.
 */
export function BotPrivacyCard({
  botId,
  privacy,
  onChanged,
}: {
  botId: string;
  privacy: BotPrivacyState;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(choice: BotPrivacyChoice) {
    setSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/bots/${encodeURIComponent(botId)}/privacy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not save Hide bot conversations. Please try again.');
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Hide bot conversations. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const labelId = `hide-conversations-${botId}`;
  return (
    <div className="mt-4 grid gap-3" role="group" aria-labelledby={labelId}>
      <div className="grid gap-0.5">
        <strong id={labelId} className="text-sm font-semibold">Hide bot conversations</strong>
        <span className="text-xs leading-snug text-muted-foreground">
          Hides this bot’s conversations and what it remembers from Orbit, analytics and error reports. The bot works the same.
          Messages are still stored and still sent to the AI provider you chose.
        </span>
      </div>
      <Segmented
        aria-labelledby={labelId}
        value={privacy.choice}
        onChange={save}
        options={[
          { value: 'follow', label: 'Follow universe', disabled: saving },
          { value: 'private', label: 'Private', disabled: saving },
          { value: 'normal', label: 'Normal', disabled: saving || privacy.universeHides },
        ]}
        className="sm:max-w-md"
      />
      {privacy.universeHides && (
        <p className="text-xs text-muted-foreground">
          This universe hides bot conversations, so every bot in it stays private. The universe owner can change that.
        </p>
      )}
      <span role="status" className="sr-only">
        {saving ? 'Saving Hide bot conversations' : ''}
      </span>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
