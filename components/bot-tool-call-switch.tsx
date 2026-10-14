'use client';

import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SettingSwitch } from '@/app/admin/components/ds';
import { authenticatedFetch } from '@/lib/client-auth';

export function BotToolCallSwitch({
  botId,
  value,
  onSaved,
}: {
  botId: string;
  value: boolean;
  onSaved: (value: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(value: boolean) {
    setSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/admin/bots/${encodeURIComponent(botId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showToolCalls: value }),
      });
      if (!response.ok) throw new Error('Could not save Show tool calls. Please try again.');
      onSaved(value);
    } catch {
      setError('Could not save Show tool calls. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 grid gap-3">
      <SettingSwitch
        id={`show-tool-calls-${botId}`}
        label="Show tool calls"
        hint="On: show tool names while this bot uses them. Off: keep tool calls hidden."
        checked={value}
        onChange={save}
        disabled={saving}
      />
      <span role="status" className="sr-only">
        {saving ? 'Saving Show tool calls' : ''}
      </span>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
