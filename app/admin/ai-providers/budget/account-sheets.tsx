'use client';

// The two things a company's row can ask for: Soniox's organization key (without it the row says it is not connected), and an amount to add at
// Agent37 (Orbit asks Agent37 for the payment link; the payment itself is made on Agent37's own page).
import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSheet } from '../../components/form-sheet';
import type { AccountView } from '@/lib/budget/types';
import { typedMicros } from './raise-sheet';

type Done = { ok: boolean; error?: string };

export function ConnectSheet({ account, onClose, onSave, onRemove }: { account: AccountView | null; onClose: () => void; onSave: (account: AccountView, key: string) => Promise<Done>; onRemove: (account: AccountView) => Promise<Done> }) {
  if (!account) return null;
  return <ConnectBody key={account.key} account={account} onClose={onClose} onSave={onSave} onRemove={onRemove} />;
}

function ConnectBody({ account, onClose, onSave, onRemove }: { account: AccountView; onClose: () => void; onSave: (account: AccountView, key: string) => Promise<Done>; onRemove: (account: AccountView) => Promise<Done> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = account.connection?.connected === true;
  const run = async (action: () => Promise<Done>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    if (!result.ok) {
      setError(result.error ?? 'It could not be saved.');
      setBusy(false);
    }
  };
  return (
    <FormSheet open onOpenChange={(open) => !open && onClose()} title={connected ? `Change the ${account.name} key` : `Connect ${account.name}`}>
      <p className="text-sm text-muted-foreground">
        {account.name} shows its balance only to an organization key, not to the usual project key. An organization admin makes one in the {account.name} console (it starts with <code>snx_org_</code>). Orbit checks it with {account.name} before it keeps it, keeps it
        encrypted, and never shows it again.
      </p>
      <Input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="snx_org_…" className="h-11" aria-label={`${account.name} organization key`} data-testid="connect-key" />
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="connect-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        {connected ? (
          <Button variant="outline" className="h-11 px-5" disabled={busy} onClick={() => run(() => onRemove(account))} data-testid="connect-remove">
            Disconnect
          </Button>
        ) : (
          <span />
        )}
        <span className="flex gap-2">
          <Button variant="outline" className="h-11 px-5" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button className="h-11 px-5" disabled={busy || key.trim() === ''} onClick={() => run(() => onSave(account, key.trim()))} data-testid="connect-save">
            {busy ? 'Checking…' : 'Save key'}
          </Button>
        </span>
      </div>
    </FormSheet>
  );
}

export function FundsSheet({ account, onClose, onAsk }: { account: AccountView | null; onClose: () => void; onAsk: (account: AccountView, amountUsd: number) => Promise<{ ok: boolean; error?: string; url?: string }> }) {
  if (!account) return null;
  return <FundsBody key={account.key} account={account} onClose={onClose} onAsk={onAsk} />;
}

function FundsBody({ account, onClose, onAsk }: { account: AccountView; onClose: () => void; onAsk: (account: AccountView, amountUsd: number) => Promise<{ ok: boolean; error?: string; url?: string }> }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const micros = typedMicros(amount);
  return (
    <FormSheet open onOpenChange={(open) => !open && onClose()} title={`Add funds at ${account.name}`}>
      <p className="text-sm text-muted-foreground">
        Orbit asks {account.name} for a payment link for the amount you type. You pay on {account.name}’s own page, and nothing is charged from here. When the balance changes, this row shows it.
      </p>
      <span className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className="h-11 w-40" aria-label={`Amount to add at ${account.name}, in dollars`} data-testid="funds-amount" />
      </span>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="funds-error">
          {error}
        </p>
      )}
      {link && (
        <Button asChild className="h-11 px-5">
          <a href={link} target="_blank" rel="noreferrer" data-testid="funds-link">
            Open the payment page
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </Button>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" onClick={onClose} disabled={busy}>
          {link ? 'Close' : 'Cancel'}
        </Button>
        {!link && (
          <Button
            className="h-11 px-5"
            disabled={busy || micros === null || micros <= 0}
            data-testid="funds-ask"
            onClick={async () => {
              if (micros === null) return;
              setBusy(true);
              setError(null);
              const result = await onAsk(account, micros / 1_000_000);
              setBusy(false);
              if (result.ok && result.url) setLink(result.url);
              else setError(result.error ?? 'Agent37 would not make a payment link.');
            }}
          >
            {busy ? 'Asking…' : 'Get the payment link'}
          </Button>
        )}
      </div>
    </FormSheet>
  );
}
