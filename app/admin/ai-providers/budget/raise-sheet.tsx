'use client';

// The raise sheet: what the budget is now, two amounts from the forecast or one typed inside the supported range, and the new monthly total before
// anything is saved. "In effect" is said only after the backend has saved it and read it back.
import { useState } from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PickCard, Radio } from '@/components/ui/choice';
import { FormSheet } from '../../components/form-sheet';
import type { AccountView, NumberView, Offer } from '@/lib/budget/types';
import { money } from './format';

export interface RaiseTarget {
  number: NumberView;
  title: string;
  spentMicros: number;
  forecastMicros: number | null;
  runsOutAt: string | null;
  offers: Offer[];
  /** The monthly budget for new funded work as a whole now, to show what it becomes. */
  totalMicros: number;
  /** A company's plan or balance beside this budget, said so a raise is not mistaken for a top up. */
  walletNote?: { line: string; name: string; url: string } | null;
  /** The amount the notice that led here suggested. */
  suggested?: number | null;
}

/** What a typed amount is, in millionths of a dollar: dollars with commas, spaces or a dollar sign, never a negative or a letter. */
export function typedMicros(text: string): number | null {
  const clean = text.replace(/[,\s$]/g, '');
  if (clean === '' || !/^\d+(\.\d+)?$/.test(clean)) return null;
  const micros = Math.round(Number(clean) * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

/** "Up to" the top when anything above nothing is allowed, else "Between" the two ends. */
export function rangeWords(range: { min: number; max: number }): string {
  return range.min <= 1 ? `Up to ${money(range.max)}.` : `Between ${money(range.min)} and ${money(range.max)}.`;
}

type OnSave = (number: NumberView, micros: number) => Promise<{ ok: boolean; error?: string }>;

/** Each number's sheet starts fresh: the body is keyed by the number, so nothing typed for one carries to another. */
export function RaiseSheet({ target, onClose, onSave }: { target: RaiseTarget | null; onClose: () => void; onSave: OnSave }) {
  if (!target) return null;
  return <RaiseBody key={target.number.id} target={target} onClose={onClose} onSave={onSave} />;
}

function RaiseBody({ target, onClose, onSave }: { target: RaiseTarget; onClose: () => void; onSave: OnSave }) {
  const [picked, setPicked] = useState<number | 'other'>(target.offers.length > 0 ? 0 : 'other');
  const [other, setOther] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { number, offers } = target;
  const now = number.value ?? 0;
  const typed = typedMicros(other);
  const range = number.range;
  const outOfRange = picked === 'other' && other.trim() !== '' && (typed === null || typed < range.min || typed > range.max);
  const to = picked === 'other' ? (typed !== null && !outOfRange ? typed : null) : offers[picked]?.micros ?? null;
  const ready = to !== null && to !== number.value;
  const total = target.totalMicros - now + (to ?? now);
  return (
    <FormSheet open onOpenChange={(open) => !open && onClose()} title={`${number.value === null ? 'Set' : 'Raise'} ${target.title}`}>
      <p className="text-sm text-muted-foreground" data-testid="raise-now">
        {number.value === null ? 'No budget is set yet.' : `${money(target.spentMicros)} spent of ${money(now)}.`}
        {target.forecastMicros !== null && ` At this pace the month needs about ${money(target.forecastMicros)}.`}
        {target.runsOutAt && ` It runs out about ${new Date(target.runsOutAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`}
      </p>
      <div role="radiogroup" aria-label="New budget" className="grid gap-2">
        {offers.map((offer, index) => (
          <PickCard key={offer.micros} role="radio" picked={picked === index} onClick={() => setPicked(index)} indicator={<Radio checked={picked === index} />} title={`${money(offer.micros)} a month`} description={offer.words} />
        ))}
        <PickCard role="radio" picked={picked === 'other'} onClick={() => setPicked('other')} indicator={<Radio checked={picked === 'other'} />} title="Another amount" />
        {picked === 'other' && (
          <span className="grid gap-1.5 px-3.5">
            <span className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input inputMode="decimal" value={other} onChange={(event) => setOther(event.target.value)} className="h-11 w-40" aria-label="New budget, in dollars" aria-invalid={outOfRange || undefined} data-testid="raise-other" />
            </span>
            <span role={outOfRange ? 'alert' : undefined} className={outOfRange ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} data-testid="raise-range">
              {outOfRange ? `That is outside what can be saved. ${rangeWords(range)}` : rangeWords(range)}
            </span>
          </span>
        )}
      </div>
      <div className="grid gap-1 rounded-2xl border border-foreground/10 bg-foreground/[.03] px-4 py-3 text-sm" data-testid="raise-total">
        <span>
          Monthly budget for new funded work becomes <strong className="tabular-nums">{money(total)}</strong>
          <span className="text-muted-foreground">{` (now ${money(target.totalMicros)})`}</span>
        </span>
        <span className="text-xs text-muted-foreground">Used by the very next request after you save. Orbit records who changed it and when. It doesn’t buy credit or add capacity at any company.</span>
      </div>
      {target.walletNote && (
        <p className="flex items-start gap-2 text-sm" data-testid="raise-wallet">
          <Wallet size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-400" />
          <span>
            {target.walletNote.line}{' '}
            <a href={target.walletNote.url} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-4">
              Open {target.walletNote.name}
            </a>
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="raise-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          className="h-11 px-5"
          disabled={!ready || saving}
          data-testid="raise-confirm"
          onClick={async () => {
            if (to === null) return;
            setSaving(true);
            setError(null);
            const result = await onSave(number, to);
            if (!result.ok) {
              setError(result.error ?? 'It could not be saved.');
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : to !== null && ready ? `${number.value !== null && to < now ? 'Lower' : number.value === null ? 'Set' : 'Raise'} to ${money(to)}` : 'Save'}
        </Button>
      </div>
    </FormSheet>
  );
}

/** The note beside a speech or voice budget when its company's plan is running low: a raise is not a top up. */
export function walletNoteFor(account: AccountView | undefined): RaiseTarget['walletNote'] {
  if (!account || (account.state !== 'low' && account.state !== 'zero')) return null;
  return { line: `A raise doesn’t add anything at ${account.name}. ${account.line}`, name: account.name, url: account.url };
}
