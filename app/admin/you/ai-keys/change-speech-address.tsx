'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authenticatedFetch } from '@/lib/client-auth';
import type { VoiceKeySummary } from '@/lib/voice-keys';
import { FormSheet } from '../../components/form-sheet';

/**
 * Change an own speech server's address (game #1874). The key stays the same key, so it stays lent and its bots stay on it: a free
 * cloudflared tunnel gets a new address each time it restarts. Nothing is saved until the new address answers with the saved key and
 * has the models the key already has. The key itself is never shown or asked for again.
 */
export function ChangeSpeechAddress({ target, onClose, onSaved }: { target: VoiceKeySummary | null; onClose: () => void; onSaved: (key: VoiceKeySummary) => void }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A sheet opened for another key starts empty
  useEffect(() => {
    setAddress('');
    setFailure(null);
  }, [target?.id]);

  async function save() {
    if (!target) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/voice-keys/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim() }),
      });
      const body: { key?: VoiceKeySummary; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok || !body.key) {
        setFailure(response.status === 401 ? 'Sign in again, then try again.' : (body.error ?? 'That didn’t save. Try again.'));
        return;
      }
      onSaved(body.key);
    } catch {
      setFailure('We couldn’t reach Universe. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={target ? `Change address of ${target.name}` : 'Change address'}
    >
      <p className="text-sm text-muted-foreground">It is checked before it is saved. The key stays lent and its bots stay on it.</p>
      {target && (
        <div className="grid gap-1.5">
          <Label htmlFor="speech-new-address">New address</Label>
          <Input
            id="speech-new-address"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://speech.example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="h-11 rounded-xl"
          />
          <p className="text-[13px] text-muted-foreground">Now: {target.address}. Must start with https:// and be reachable from the internet.</p>
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
        <Button className="h-11 px-5" disabled={busy || address.trim() === ''} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
        </Button>
      </div>
    </FormSheet>
  );
}
