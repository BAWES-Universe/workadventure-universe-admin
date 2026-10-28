'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authenticatedFetch } from '@/lib/client-auth';
import { kindInfo } from '@/lib/ai-key-kinds';
import type { AiKeySummary } from '@/lib/ai-keys';
import { ProviderLogo } from '../../components/ds/provider-logo';
import { AiKeyFailure, aiKeyError, aiKeyFailureText } from '../../hooks/use-ai-keys';

/** The longest a key's name may be, as on Add a key. */
export const KEY_NAME_MAX = 60;

/** The pencil beside a key's name: a quiet round button that opens the name for editing (#633). */
export function RenameButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Rename ${name}`}
      onClick={onClick}
      data-testid="ai-key-rename"
      className="orbit-press -ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[.06] text-muted-foreground hover:bg-foreground/[.1]"
    >
      <Pencil size={18} aria-hidden="true" />
    </button>
  );
}

/**
 * A key's name, open for editing in place (#633): the name field with its hint and count, Cancel and Save name. Only the
 * name changes: the key keeps its id, so its lends and the bots on it stay. `onRenamed` gets the saved name.
 */
export function RenameKey({ keyItem, onRenamed, onCancel }: { keyItem: AiKeySummary; onRenamed: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(keyItem.name);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const empty = trimmed === '';

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (empty || saving) return;
    // Nothing changed: close without a request
    if (trimmed === keyItem.name) return onCancel();
    setSaving(true);
    setFailure(null);
    try {
      const response = await authenticatedFetch(`/api/me/ai-keys/${encodeURIComponent(keyItem.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new AiKeyFailure(aiKeyError(response.status, body?.error));
      }
      onRenamed(trimmed);
    } catch (error) {
      setFailure(aiKeyFailureText(error));
      setSaving(false);
    }
  }

  const problem = empty ? 'Give the key a name.' : failure;
  return (
    <form onSubmit={save} className="grid min-w-0 flex-1 basis-full gap-1.5" data-testid="ai-key-rename-form">
      <div className="flex items-center gap-2">
        <ProviderLogo info={keyItem.kind ? kindInfo(keyItem.kind) : undefined} />
        <Label htmlFor={`ai-key-name-${keyItem.id}`} className="text-[13px] font-semibold text-muted-foreground">
          Key name
        </Label>
      </div>
      <Input
        id={`ai-key-name-${keyItem.id}`}
        ref={input}
        value={name}
        maxLength={KEY_NAME_MAX}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`ai-key-name-note-${keyItem.id}`}
        onChange={(event) => {
          setName(event.target.value);
          setFailure(null);
        }}
        onKeyDown={(event) => {
          // Like Cancel, not while the name is saving: a late answer would then close whichever key is open by then
          if (event.key === 'Escape' && !saving) onCancel();
        }}
        className={`h-11 rounded-xl ${problem ? 'border-[#fb923c]' : 'border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)]'}`}
      />
      <div className="flex justify-between gap-2 text-[12px]" id={`ai-key-name-note-${keyItem.id}`}>
        <span role={problem ? 'alert' : undefined} className={problem ? 'font-semibold text-[#fb923c]' : 'text-muted-foreground'} data-testid="ai-key-rename-note">
          {problem ?? 'Shown on this card, in Runs on and when you revoke it.'}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {name.length}/{KEY_NAME_MAX}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" variant="outline" className="h-11 px-5" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" className="h-11 px-5" disabled={empty || saving} data-testid="ai-key-rename-save">
          {saving ? 'Saving…' : 'Save name'}
        </Button>
      </div>
    </form>
  );
}
