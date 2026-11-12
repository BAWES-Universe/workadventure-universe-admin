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
      if (!response.ok) throw new Error('Could not save Show app use. Please try again.');
      onSaved(value);
    } catch {
      setError('Could not save Show app use. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 grid gap-3">
      <SettingSwitch
        id={`show-tool-calls-${botId}`}
        label="Show app use"
        hint="On: shows which app it used in chat. Off: app use stays hidden."
        checked={value}
        onChange={save}
        disabled={saving}
      />
      <span role="status" className="sr-only">
        {saving ? 'Saving Show app use' : ''}
      </span>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
