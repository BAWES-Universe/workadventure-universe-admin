'use client';

// What one person uses, and how a super admin gives them extra usage (game #1999). Every member has the same default allowance, so
// nothing is switched on per person (Khalid, 11 Nov). Amounts are multiples of the usual on purpose. A gift is never owed; "I'll bill
// for it" only records what was agreed outside Universe, and the person sees one plain line and nothing about billing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PickCard, Radio, Segmented } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { FormSheet } from '../../components/form-sheet';
import { LoadError, StatLine } from '../../components/ds';
import { amountWords, day, dollars } from '@/lib/costs-words';
import type { PersonUsage } from '@/lib/meter-person';

type Amount = 'double' | 'five' | 'none';
type Until = '7' | '30' | 'date';
type Billing = 'gift' | 'to_bill';

const AMOUNTS: { value: Amount; label: string; meaning: string }[] = [
  { value: 'double', label: 'Double', meaning: 'Twice the usual, for chat, voice and computer time.' },
  { value: 'five', label: '5 times', meaning: 'Five times the usual, for chat, voice and computer time.' },
  { value: 'none', label: 'No limit', meaning: 'Never held back. It still shows on the Costs page.' },
];

const amountOf = (usage: { multiplier: number | null; noLimit: boolean }): Amount => (usage.noLimit ? 'none' : usage.multiplier === 2 ? 'double' : 'five');
const inDays = (days: number) => new Date(Date.now() + days * 86400000);
const dateInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const gb = (bytes: number) => (bytes <= 0 ? null : `${(bytes / 1_000_000_000).toFixed(1)} GB kept`);

export function ExtraUsage({ userId, name }: { userId: string; name: string }) {
  const { addToast } = useToast();
  const [usage, setUsage] = useState<PersonUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [amount, setAmount] = useState<Amount>('five');
  const [until, setUntil] = useState<Until>('30');
  const [date, setDate] = useState(() => dateInput(inDays(30)));
  // A gift is never owed. "I'll bill for it" only marks it on the Costs page: nothing in Universe takes money, and the person sees no bill.
  const [bill, setBill] = useState<Billing>('gift');
  const [note, setNote] = useState('');
  // One key per thing the admin asked for: a double tap, or a second try after an answer that never came back, gives the extra
  // usage once. It is kept until the server has answered (saved or refused), and a different request gets a new key.
  const pendingKey = useRef<{ key: string; sig: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const read = useCallback(async (): Promise<PersonUsage> => {
    const { authenticatedFetch } = await import('@/lib/client-auth');
    const response = await authenticatedFetch(`/api/admin/users/${encodeURIComponent(userId)}/extra-usage`);
    if (!response.ok) throw new Error('load');
    return (await response.json()) as PersonUsage;
  }, [userId]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setUsage(await read());
    } catch {
      setFailed(true);
    }
  }, [read]);

  useEffect(() => {
    load();
  }, [load]);

  // The end the sheet says: a date means the end of that day where the super admin is
  const ends = until === 'date' ? new Date(`${date}T23:59:59`) : inDays(Number(until));
  const endsOn = Number.isNaN(ends.getTime()) || ends.getTime() <= Date.now() ? null : day(ends.toISOString());

  function openSheet(change: boolean) {
    setChanging(change);
    if (change && usage?.extra) {
      setAmount(amountOf(usage.extra));
      setUntil('date');
      setDate(dateInput(new Date(usage.extra.endsAt)));
      setBill(usage.extra.settlement);
      setNote(usage.extra.note ?? '');
    } else {
      setAmount('five');
      setUntil('30');
      setDate(dateInput(inDays(30)));
      setBill('gift');
      setNote('');
    }
    setOpen(true);
  }

  /** `done`: saved. `refused`: the server said no, so nothing was given. `unsure`: no answer came back, so it may have been saved. */
  async function send(method: 'POST' | 'PATCH', body: Record<string, unknown>): Promise<'done' | 'refused' | 'unsure'> {
    setSaving(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/users/${encodeURIComponent(userId)}/extra-usage`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => null)) as { usage?: PersonUsage; error?: string } | null;
      if (!response.ok) {
        addToast({ description: data?.error || 'That didn’t save. Try again.', variant: 'error' });
        // A 5xx may have saved before it failed; anything else is a plain no
        return response.status >= 500 ? 'unsure' : 'refused';
      }
      if (data?.usage) setUsage(data.usage);
      return 'done';
    } catch {
      addToast({ description: 'That didn’t save. Check your connection and try again.', variant: 'error' });
      return 'unsure';
    } finally {
      setSaving(false);
    }
  }

  if (failed) return <LoadError label={`${name}’s usage`} retry={load} />;
  if (!usage) return null;

  const extra = usage.extra;
  const used = dollars(usage.computerMonthMicros);
  // No limit shows first: a running no-limit grant counts even when the usual allowance is not set
  const computer = usage.noLimit ? `${used} this month, no limit` : !usage.allowanceSet ? `${used} this month` : `${used} of ${dollars(usage.allowanceMicros ?? 0)} this month`;
  // An ask shows beside a running grant too: someone can use up a raised allowance and ask again
  const asked = usage.asked;

  return (
    <div className="grid min-w-0 gap-3" data-testid="extra-usage">
      <div className="grid gap-0.5">
        <h2 className="text-sm font-semibold">Usage</h2>
        <StatLine items={['Chat and voice', `${dollars(usage.chatWeekMicros)} in the last 7 days`, `${usage.bricks} ${usage.bricks === 1 ? 'Brick' : 'Bricks'}`]} />
        <StatLine items={['Computer', computer, gb(usage.keptBytes)]} />
        {!extra && !asked && <p className="text-xs text-muted-foreground">On the usual allowance, like every member.</p>}
      </div>
      {asked && usage.asked && (
        <div className="grid min-w-0 gap-0.5 rounded-[14px] border bg-card px-[14px] py-3" data-testid="extra-usage-asked">
          <strong className="text-sm font-semibold">{name} asked for more</strong>
          <span className="text-xs text-muted-foreground">
            {new Date(usage.asked.at).toDateString() === new Date().toDateString() ? 'Today' : day(usage.asked.at)} at{' '}
            {new Date(usage.asked.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · Computer time is used up for this month
          </span>
        </div>
      )}
      {extra ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-[14px] border bg-card px-[14px] py-3" data-testid="extra-usage-given">
          <span className="grid min-w-0 gap-0.5">
            <strong className="text-sm font-semibold">Extra usage until {day(extra.endsAt)}</strong>
            <span className="text-xs text-muted-foreground">
              {amountWords(extra)} · given by {extra.givenByName} {new Date(extra.startsAt).toDateString() === new Date().toDateString() ? 'today' : `on ${day(extra.startsAt)}`} ·{' '}
              {extra.settlement === 'gift' ? 'a gift' : extra.billedAt ? `billed ${day(extra.billedAt)}` : 'to bill'}
            </span>
            {extra.note && extra.settlement === 'to_bill' && <span className="text-xs text-muted-foreground">{extra.note}</span>}
          </span>
          <span className="flex min-w-0 flex-wrap gap-2">
            {!extra.billedAt && (
              <Button variant="outline" className="h-11 px-4" disabled={saving} onClick={() => openSheet(true)}>
                Change
              </Button>
            )}
            <Button variant="outline" className="h-11 px-4" disabled={saving} onClick={() => send('PATCH', { grantKey: extra.grantKey, action: 'end' })}>
              End it now
            </Button>
            {extra.settlement === 'to_bill' && !extra.billedAt && (
              <Button variant="outline" className="h-11 px-4" disabled={saving} data-testid="extra-usage-billed" onClick={() => send('PATCH', { grantKey: extra.grantKey, action: 'billed' })}>
                Mark as billed
              </Button>
            )}
          </span>
        </div>
      ) : (
        <div>
          <Button variant="outline" className="h-11 px-5" onClick={() => openSheet(false)} data-testid="extra-usage-give">
            Give extra usage
          </Button>
        </div>
      )}

      <FormSheet
        open={open}
        onOpenChange={setOpen}
        title={changing ? `Change ${name}’s extra usage` : `Give ${name} extra usage`}
        description={`Raises ${name}’s chat, voice and computer allowances together. A Brick on a person’s own key is never held back.`}
      >
        <div className="grid gap-5">
          <div className="grid gap-2">
            <h3 id="extra-amount" className="text-sm font-semibold">
              How much
            </h3>
            <div role="radiogroup" aria-labelledby="extra-amount" className="grid gap-2">
              {AMOUNTS.map((option) => (
                <PickCard key={option.value} role="radio" picked={amount === option.value} onClick={() => setAmount(option.value)} indicator={<Radio checked={amount === option.value} />} title={option.label} description={option.meaning} />
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <h3 id="extra-until" className="text-sm font-semibold">
              Until
            </h3>
            <Segmented<Until>
              aria-labelledby="extra-until"
              value={until}
              onChange={setUntil}
              options={[
                { value: '7', label: '7 days' },
                { value: '30', label: '30 days' },
                { value: 'date', label: 'A date' },
              ]}
            />
            {until === 'date' && <Input type="date" className="h-11" aria-label="Ends on" value={date} onChange={(event) => setDate(event.target.value)} />}
            {endsOn && <p className="text-sm text-muted-foreground">Ends on {endsOn}, then goes back to the usual by itself.</p>}
          </div>

          {!changing && (
            <div className="grid gap-2" data-testid="extra-usage-billing">
              <h3 id="extra-bill" className="text-sm font-semibold">
                Gift or bill
              </h3>
              <Segmented<Billing>
                aria-labelledby="extra-bill"
                value={bill}
                onChange={setBill}
                options={[
                  { value: 'gift', label: 'A gift' },
                  { value: 'to_bill', label: 'I’ll bill for it' },
                ]}
              />
              {bill === 'to_bill' && <Input className="h-11" aria-label="Note for the bill" placeholder="What was agreed, if you like" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />}
              <p className="text-sm text-muted-foreground">
                {bill === 'gift' ? 'A gift is never owed.' : 'Nothing is charged here. It stays marked “To bill” on the Costs page until you mark it billed.'}
              </p>
            </div>
          )}

          <p className="flex items-start gap-2 rounded-xl bg-foreground/[.04] px-3.5 py-2.5 text-sm">
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
            <span>
              {name} sees one line on their Usage page: “You have extra usage until {endsOn ?? 'then'}.” Nothing about billing shows in Universe. It is listed on the Costs page with the dates.
            </span>
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="outline" className="h-11 px-5" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              className="h-11 px-5"
              disabled={!endsOn || saving}
              data-testid="extra-usage-confirm"
              onClick={async () => {
                if (changing && extra) {
                  // Only what the admin changed is sent, so another admin's change is not undone and an end date nobody touched does not move
                  const change: Record<string, unknown> = { grantKey: extra.grantKey, action: 'change' };
                  if (amount !== amountOf(extra)) change.amount = amount;
                  if (!(until === 'date' && date === dateInput(new Date(extra.endsAt)))) change.endsAt = ends.toISOString();
                  if (extra.settlement === 'to_bill' && note !== (extra.note ?? '')) change.note = note;
                  if (Object.keys(change).length === 2) {
                    setOpen(false);
                    return;
                  }
                  if ((await send('PATCH', change)) === 'done') setOpen(false);
                  return;
                }
                const sig = JSON.stringify({ amount, until, date: until === 'date' ? date : null, bill, note: bill === 'to_bill' ? note : null });
                if (pendingKey.current && pendingKey.current.sig !== sig) {
                  // The last try got no answer and this is something else: look at what the server has before giving again, since
                  // that one may have been saved
                  setSaving(true);
                  let fresh: PersonUsage | null = null;
                  try {
                    fresh = await read();
                  } catch {
                    fresh = null;
                  }
                  setSaving(false);
                  if (!fresh) {
                    addToast({ description: 'We couldn’t check whether the last try was saved. Try again in a moment.', variant: 'error' });
                    return;
                  }
                  setUsage(fresh);
                  if (fresh.extra?.grantKey === `${userId}:${pendingKey.current.key}`.slice(0, 255)) {
                    pendingKey.current = null;
                    addToast({ description: 'The last try was saved after all, so nothing more was given.', variant: 'success' });
                    setOpen(false);
                    return;
                  }
                }
                if (pendingKey.current?.sig !== sig) pendingKey.current = { key: crypto.randomUUID(), sig };
                const outcome = await send('POST', { grantKey: pendingKey.current.key, amount, endsAt: ends.toISOString(), settlement: bill, note: bill === 'to_bill' ? note : null });
                if (outcome !== 'unsure') pendingKey.current = null;
                if (outcome === 'done') setOpen(false);
              }}
            >
              {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {changing ? 'Save' : 'Give extra usage'}
            </Button>
          </div>
        </div>
      </FormSheet>
    </div>
  );
}
