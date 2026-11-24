'use client';

// The sheets of the Grants page (spec v3 sections 2, 2a, 7a and 11): Universe AI replies, a default for Instant Apps or computers,
// an exception, and "Give credit". Each shows the three-part preview before anything is saved, and each save is one request.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/choice';
import { useToast } from '@/components/ui/toast';
import { FormSheet } from '../../components/form-sheet';
import {
  CATEGORY_NAME,
  MONEY_CATEGORIES,
  aiPreviewRows,
  dollarsText,
  microsOfDollars,
  usd,
  type ExceptionSetting,
  type ExceptionView,
  type GiftScope,
  type Interval,
  type MoneyCategory,
  type MoneyDefaultView,
  type PreviewRequest,
  type Recipients,
} from '@/lib/grants-view';
import { Chosen, Clash, Group, Preview, RecipientPicker, SheetButtons, Words, draftOfAudience, emptyDraft, recipientsOf, sendJson, usePreview, useResetWhen, type RecipientDraft } from './grants-parts';

type Done = () => void;

const dateInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

// ---- Universe AI replies ----

export function AiSheet({ open, onClose, onSaved, ai }: { open: boolean; onClose: Done; onSaved: Done; ai: { signedIn: number; guest: number; windowHours: number } }) {
  const { addToast } = useToast();
  const [signedIn, setSignedIn] = useState(String(ai.signedIn));
  const [guest, setGuest] = useState(String(ai.guest));
  const [saving, setSaving] = useState(false);
  useResetWhen(open, [open, ai.signedIn, ai.guest], () => {
    setSignedIn(String(ai.signedIn));
    setGuest(String(ai.guest));
  });
  const signedInN = Number(signedIn);
  const guestN = Number(guest);
  const valid = Number.isInteger(signedInN) && signedInN >= 1 && Number.isInteger(guestN) && guestN >= 1;

  async function save() {
    setSaving(true);
    const result = await sendJson('/api/admin/bot-limits', 'PATCH', { fairUsage: { signedIn: signedInN, guest: guestN } });
    setSaving(false);
    if (!result.ok) {
      addToast({ description: result.error ?? 'That didn’t save.', variant: 'error' });
      return;
    }
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    onSaved();
  }

  return (
    <FormSheet open={open} onOpenChange={(next) => !next && onClose()} title="Universe AI replies" description="Text and spoken answers share one reply allowance. A Brick on its maker’s own key doesn’t use it.">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) save();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Group label="Signed-in people">
            <Input className="h-11" inputMode="numeric" aria-label="Replies for signed-in people" value={signedIn} onChange={(event) => setSignedIn(event.target.value)} />
          </Group>
          <Group label="Guests">
            <Input className="h-11" inputMode="numeric" aria-label="Replies for guests" value={guest} onChange={(event) => setGuest(event.target.value)} />
          </Group>
        </div>
        <Group label="Window, in hours">
          <Input className="h-11" inputMode="numeric" aria-label="Window in hours" value={ai.windowHours} readOnly disabled />
          <p className="text-sm text-muted-foreground">It starts at someone’s first reply and resets that many hours later. People see the exact reset time.</p>
        </Group>
        <div className="grid gap-0 overflow-hidden rounded-xl bg-foreground/[.04]" data-testid="grants-preview">
          {aiPreviewRows(valid ? signedInN : ai.signedIn, valid ? guestN : ai.guest, ai.windowHours).map(([label, text]) => (
            <div key={label} className="grid gap-0.5 border-b border-foreground/[.06] px-3.5 py-2.5 last:border-b-0">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
              <span className="text-sm">
                <Words parts={text} />
              </span>
            </div>
          ))}
        </div>
        <SheetButtons go="Save" disabled={!valid} saving={saving} onCancel={onClose} />
      </form>
    </FormSheet>
  );
}

// ---- A default for Instant Apps or computers ----

type StartsOn = 'next' | 'now';

export function DefaultSheet({ category, view, onClose, onSaved }: { category: MoneyCategory | null; view: MoneyDefaultView | null; onClose: Done; onSaved: Done }) {
  const { addToast } = useToast();
  const [amount, setAmount] = useState('');
  const [interval, setInterval] = useState<Interval>('once');
  const [whom, setWhom] = useState<'all' | 'new_from'>('all');
  const [from, setFrom] = useState('');
  const [startsOn, setStartsOn] = useState<StartsOn>('next');
  const [saving, setSaving] = useState(false);
  useResetWhen(!!category && !!view, [category, view], () => {
    if (!category || !view) return;
    setAmount(dollarsText(view.amountMicros));
    // Computer credit is monthly for everyone for now: it follows the one monthly allowance every member has
    setInterval(category === 'computers' ? (view.set && view.interval === 'none' ? 'none' : 'monthly') : view.set ? view.interval : 'once');
    setWhom(view.recipients?.kind === 'new_from' ? 'new_from' : 'all');
    setFrom(view.recipients?.kind === 'new_from' ? view.recipients.from.slice(0, 10) : dateInput(new Date()));
    setStartsOn('next');
  });

  const micros = microsOfDollars(amount);
  const recipients: Recipients | null = interval === 'once' && whom === 'new_from' ? (from ? { kind: 'new_from', from } : null) : { kind: 'all' };
  const ready = !!category && recipients !== null && (interval === 'none' || micros !== null);
  const request: PreviewRequest | null = category && recipients ? { what: 'default', category, amountMicros: interval === 'none' ? null : micros, interval, recipients, ...(interval === 'monthly' ? { startsOn } : {}) } : null;
  // A default with no amount yet asks for no preview: it says "Type an amount" instead
  const { preview, loading } = usePreview(category && request && (interval === 'none' || micros !== null) ? request : null);
  const name = category ? CATEGORY_NAME[category] : '';

  async function save() {
    if (!category || !request || !recipients) return;
    setSaving(true);
    const { what: _what, category: _category, ...body } = request as Extract<PreviewRequest, { what: 'default' }>;
    void _what;
    void _category;
    const result = await sendJson(`/api/admin/grants/defaults/${category}`, 'PUT', body);
    setSaving(false);
    if (!result.ok) {
      addToast({ description: result.error ?? 'That didn’t save.', variant: 'error' });
      return;
    }
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    onSaved();
  }

  return (
    <FormSheet
      open={!!category}
      onOpenChange={(next) => !next && onClose()}
      title={`${name} for everyone`}
      description={category === 'instant_apps' ? 'For apps that work without connecting anything. Apps people connect themselves stay free.' : 'For a Brick’s computer jobs: the computer, the AI it uses there, and paid apps inside the job.'}
    >
      {category && request !== undefined && (
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save();
          }}
        >
          <Group label="How much, in US dollars">
            <Input className="h-11" inputMode="decimal" placeholder="For example 2" aria-label="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} data-testid="grants-amount" />
            {amount.trim() !== '' && micros === null && <p className="text-sm text-muted-foreground">Type an amount in dollars, like 2 or 2.50.</p>}
          </Group>
          <Group label="How often">
            <Segmented<Interval>
              aria-label="How often"
              value={interval}
              onChange={setInterval}
              options={[
                ...(category === 'computers' ? [] : [{ value: 'once' as Interval, label: 'Once' }]),
                { value: 'monthly', label: 'Every month' },
                { value: 'none', label: 'None' },
              ]}
            />
            <p className="text-sm text-muted-foreground">
              {interval === 'once' ? 'Given once. When it’s used up, people can ask for more, use their own apps, or later pay.' : interval === 'monthly' ? 'Renews on the 1st. What’s left doesn’t carry over.' : 'No credit from the default. Exceptions and gifts still work.'}
            </p>
          </Group>
          {interval === 'once' && (
            <Group label="Give credit to">
              <Segmented<'all' | 'new_from'>
                aria-label="Give credit to"
                value={whom}
                onChange={setWhom}
                options={[
                  { value: 'all', label: 'All signed-in members' },
                  { value: 'new_from', label: 'New people from a date' },
                ]}
              />
              {whom === 'new_from' && <Input type="date" className="h-11" aria-label="From" value={from} onChange={(event) => setFrom(event.target.value)} />}
            </Group>
          )}
          {interval === 'monthly' && (
            <Group label="Starts">
              <Segmented<StartsOn>
                aria-label="Starts"
                value={startsOn}
                onChange={setStartsOn}
                options={[
                  { value: 'next', label: 'On the 1st' },
                  { value: 'now', label: 'Now' },
                ]}
              />
            </Group>
          )}
          {request && <Preview request={request} preview={preview} loading={loading} />}
          <SheetButtons go="Save" disabled={!ready} saving={saving} onCancel={onClose} />
        </form>
      )}
    </FormSheet>
  );
}

// ---- An exception ----

type Mode = 'same' | 'own' | 'none';
interface SettingDraft {
  mode: Mode;
  amount: string;
  interval: 'once' | 'monthly';
}
const sameDraft = (): SettingDraft => ({ mode: 'same', amount: '', interval: 'monthly' });
const draftOfSetting = (setting: ExceptionSetting): SettingDraft => (setting.mode === 'own' ? { mode: 'own', amount: dollarsText(setting.amountMicros), interval: setting.interval } : { ...sameDraft(), mode: setting.mode });
const settingOf = (draft: SettingDraft): ExceptionSetting | null => {
  if (draft.mode !== 'own') return { mode: draft.mode };
  const micros = microsOfDollars(draft.amount);
  return micros === null ? null : { mode: 'own', amountMicros: micros, interval: draft.interval };
};

export function ExceptionSheet({ open, editing, onClose, onSaved }: { open: boolean; editing: ExceptionView | null; onClose: Done; onSaved: Done }) {
  const { addToast } = useToast();
  const [audience, setAudience] = useState<RecipientDraft>(emptyDraft('people'));
  const [settings, setSettings] = useState<Record<MoneyCategory, SettingDraft>>({ instant_apps: sameDraft(), computers: sameDraft() });
  const [choice, setChoice] = useState<'this' | 'other' | null>(null);
  const [saving, setSaving] = useState(false);
  useResetWhen(open, [open, editing], () => {
    setChoice(null);
    if (editing) {
      setAudience(draftOfAudience(editing.audience));
      setSettings({ instant_apps: draftOfSetting(editing.instant_apps), computers: draftOfSetting(editing.computers) });
    } else {
      setAudience(emptyDraft('people'));
      setSettings({ instant_apps: sameDraft(), computers: sameDraft() });
    }
  });

  const who = recipientsOf(audience);
  const apps = settingOf(settings.instant_apps);
  const computers = settingOf(settings.computers);
  // An exception that already exists may go back to "As everyone" in both: the server ends the rule. A new one needs a category chosen.
  const ready = !!who && !!apps && !!computers && (!!editing || apps.mode !== 'same' || computers.mode !== 'same');
  const request: PreviewRequest | null = who && apps && computers ? { what: 'exception', audience: who, instant_apps: apps, computers, ...(editing ? { replaceId: editing.id } : {}) } : null;
  const { preview, loading } = usePreview(open && ready ? request : null);
  const clash = preview?.clash ?? null;
  // A clash must be answered before saving; a new one starts unanswered
  // The choice belongs to the draft it was made for: changing a category, an amount or the people asks it again, even for the same rule
  const clashKey = clash ? JSON.stringify([clash.people, clash.other.name, request]) : '';
  useResetWhen(true, [clashKey], () => setChoice(null));

  async function save() {
    if (!request) return;
    setSaving(true);
    const { what: _what, ...body } = request as Extract<PreviewRequest, { what: 'exception' }>;
    void _what;
    const result = await sendJson('/api/admin/grants/exceptions', 'POST', { ...body, ...(clash && choice ? { clashChoice: choice } : {}) });
    setSaving(false);
    if (!result.ok) {
      addToast({ description: result.error ?? 'That didn’t save.', variant: 'error' });
      return;
    }
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    onSaved();
  }

  return (
    <FormSheet open={open} onOpenChange={(next) => !next && onClose()} title={editing ? 'Change an exception' : 'Add an exception'} description="A standing rule for some people, in place of the defaults.">
      <form
        className="grid max-h-[70dvh] gap-5 overflow-y-auto"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && (!clash || choice)) save();
        }}
      >
        {editing ? (
          <Group label="For">
            <Chosen title={editing.audience.kind === 'universe' ? editing.audience.universe?.name ?? 'A universe' : `${editing.audience.people.length} ${editing.audience.people.length === 1 ? 'person' : 'people'} you picked`} faces={editing.audience.people} />
          </Group>
        ) : (
          <Group label="For">
            <RecipientPicker allow={['people', 'universe']} draft={audience} onChange={setAudience} />
          </Group>
        )}
        {MONEY_CATEGORIES.map((category) => {
          const draft = settings[category];
          const label = CATEGORY_NAME[category];
          const set = (next: SettingDraft) => setSettings({ ...settings, [category]: next });
          return (
            <Group key={category} label={label}>
              <Segmented<Mode>
                aria-label={label}
                value={draft.mode}
                onChange={(mode) => set({ ...draft, mode })}
                options={[
                  { value: 'same', label: 'As everyone' },
                  { value: 'own', label: 'Its own' },
                  { value: 'none', label: 'No grant' },
                ]}
              />
              {draft.mode === 'own' && (
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Input className="h-11" inputMode="decimal" aria-label={`${label} amount`} value={draft.amount} onChange={(event) => set({ ...draft, amount: event.target.value })} />
                  <Segmented<'once' | 'monthly'>
                    aria-label={`${label} how often`}
                    value={draft.interval}
                    onChange={(interval) => set({ ...draft, interval })}
                    options={[
                      { value: 'once', label: 'Once' },
                      { value: 'monthly', label: 'Monthly' },
                    ]}
                  />
                </div>
              )}
            </Group>
          );
        })}
        {clash && <Clash clash={clash} choice={choice} onChoose={setChoice} />}
        {request && <Preview request={request} preview={preview} loading={loading} />}
        <SheetButtons go="Save" disabled={!ready || (!!clash && !choice) || loading} saving={saving} onCancel={onClose} />
      </form>
    </FormSheet>
  );
}

// ---- Give credit (a gift) ----

type Settlement = 'gift' | 'to_bill';

export function GiftSheet({ open, onClose, onSaved }: { open: boolean; onClose: Done; onSaved: Done }) {
  const { addToast } = useToast();
  const [audience, setAudience] = useState<RecipientDraft>(emptyDraft('people'));
  const [picking, setPicking] = useState(true);
  const [scope, setScope] = useState<GiftScope>('both');
  const [amount, setAmount] = useState('');
  const [shared, setShared] = useState<'each' | 'shared'>('each');
  const [until, setUntil] = useState('');
  const [settlement, setSettlement] = useState<Settlement>('gift');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // One key per gift the admin is giving: a double tap, or a second try after an answer that never came back, gives it once. It lasts
  // until the server has answered, and a gift with other figures gets a new key.
  const pending = useRef<{ key: string; sig: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setAudience(emptyDraft('people'));
    setPicking(true);
    setScope('both');
    setAmount('');
    setShared('each');
    setUntil(dateInput(inDays(30)));
    setSettlement('gift');
    setNote('');
    pending.current = null;
  }, [open]);

  const zoneName = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  })();
  const endsAtDate = until ? new Date(`${until}T23:59:59`) : null;
  const endsAt = endsAtDate && !Number.isNaN(endsAtDate.getTime()) && endsAtDate.getTime() > Date.now() ? endsAtDate.toISOString() : null;
  const who = recipientsOf(audience);
  const micros = microsOfDollars(amount);
  // Credit to be billed says what was agreed: the books refuse it without
  const ready = !!who && micros !== null && !!endsAt && (settlement === 'gift' || note.trim() !== '');
  const request: PreviewRequest | null = who && micros !== null && endsAt ? { what: 'gift', audience: who, scope, amountMicros: micros, shared: shared === 'shared', endsAt, ...(audience.kind === 'universe' && audience.changing ? { joinerCap: Number(audience.joinerCap) } : {}) } : null;
  const { preview, loading } = usePreview(open && !picking ? request : null);

  async function save() {
    if (!request) return;
    const sig = JSON.stringify({ request, settlement, note });
    if (!pending.current || pending.current.sig !== sig) pending.current = { key: crypto.randomUUID(), sig };
    setSaving(true);
    const { what: _what, ...body } = request as Extract<PreviewRequest, { what: 'gift' }>;
    void _what;
    const result = await sendJson('/api/admin/grants/gifts', 'POST', { ...body, grantKey: pending.current.key, settlement, note: settlement === 'to_bill' && note.trim() ? note.trim() : null });
    setSaving(false);
    // The key lasts while the books may have saved it without our hearing (no answer, or a server error, or a sign-in that failed
    // on the way back: the first try may have been saved before it); a clear answer (saved, or refused with a 4xx that says so), ends it.
    // Saving again with the same key never gives twice.
    const refused = result.status >= 400 && result.status < 500 && ![401, 403, 408].includes(result.status);
    if (result.ok || refused) pending.current = null;
    if (!result.ok) {
      addToast({ description: result.error ?? 'That didn’t save.', variant: 'error' });
      return;
    }
    addToast({ description: 'Saved', variant: 'success', duration: 2000 });
    onSaved();
  }

  // The recipients step is done when it names who: people, a universe (and, for a changing group, how many may join), a date
  const audienceComplete = !!recipientsOf(audience);
  const audienceTitle = audience.kind === 'all' ? 'All signed-in members' : audience.kind === 'new_from' ? 'New people from a date' : audience.kind === 'universe' ? `${audience.universe?.name ?? 'A universe'}’s members` : `${audience.people.length} ${audience.people.length === 1 ? 'person' : 'people'} you picked`;

  return (
    <FormSheet open={open} onOpenChange={(next) => !next && onClose()} title={picking ? 'Give credit to…' : 'Give credit'} description={picking ? 'Who this gift is for. Being picked gives no rooms, apps or admin rights.' : 'A one-time extra with an end date. Paid by Universe.'}>
      {picking ? (
        <div className="grid max-h-[70dvh] gap-5 overflow-y-auto">
          <RecipientPicker allow={['people', 'universe', 'all', 'new_from']} draft={audience} onChange={setAudience} />
          {audience.kind === 'universe' && audience.universe && (
            <Group label="Who is in it">
              <Segmented<'snapshot' | 'changing'>
                aria-label="Who is in it"
                value={audience.changing ? 'changing' : 'snapshot'}
                onChange={(mode) => setAudience({ ...audience, changing: mode === 'changing' })}
                options={[
                  { value: 'snapshot', label: 'Who’s in it now' },
                  { value: 'changing', label: 'Also people who join' },
                ]}
              />
              {audience.changing && (
                <Input className="h-11" inputMode="numeric" aria-label="Most people who can join" placeholder="Most people who can join" value={audience.joinerCap} onChange={(event) => setAudience({ ...audience, joinerCap: event.target.value })} />
              )}
              <p className="text-sm text-muted-foreground">{audience.changing ? 'It ends with the gift’s end date, and no more than that many people can join. Joining, leaving or rejoining never makes new credit.' : 'Only the people in it today. Joining later gives nothing.'}</p>
            </Group>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="h-11 px-5" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" className="h-11 px-5" disabled={!audienceComplete} onClick={() => setPicking(false)} data-testid="grants-recipients-done">
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid max-h-[70dvh] gap-5 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save();
          }}
        >
          <Group label="Give credit to">
            <Chosen title={audienceTitle} faces={audience.kind === 'people' ? audience.people : undefined} onChange={() => setPicking(true)} />
          </Group>
          <Group label="Pays for">
            <Segmented<GiftScope>
              aria-label="Pays for"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'apps', label: 'Instant Apps' },
                { value: 'computers', label: 'Computers' },
                { value: 'both', label: 'Both' },
              ]}
            />
          </Group>
          <Group label="How much, in US dollars">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input className="h-11" inputMode="decimal" aria-label="Gift amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
              <Segmented<'each' | 'shared'>
                aria-label="Each or shared"
                value={shared}
                onChange={setShared}
                options={[
                  { value: 'each', label: 'Each person' },
                  { value: 'shared', label: 'Shared in total' },
                ]}
              />
            </div>
          </Group>
          <Group label="Until">
            <Input type="date" className="h-11" aria-label="Ends on" value={until} onChange={(event) => setUntil(event.target.value)} />
            {until && !endsAt && <p className="text-sm text-muted-foreground">Pick a day in the future. Every gift ends.</p>}
            {endsAt && <p className="text-sm text-muted-foreground">Ends at the end of that day in your time zone{zoneName ? ` (${zoneName})` : ''}. The list and the preview show the same day.</p>}
          </Group>
          <Group label="Gift or bill">
            <Segmented<Settlement>
              aria-label="Gift or bill"
              value={settlement}
              onChange={setSettlement}
              options={[
                { value: 'gift', label: 'A gift' },
                { value: 'to_bill', label: 'I’ll bill for it' },
              ]}
            />
            {settlement === 'to_bill' && <Input className="h-11" aria-label="What was agreed" placeholder="What was agreed, and the invoice reference" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />}
            <p className="text-sm text-muted-foreground">{settlement === 'gift' ? 'A gift is never owed.' : 'Nothing is charged here. This records what you agreed with them outside Universe, and “Mark as billed” says it was billed.'}</p>
          </Group>
          {request && <Preview request={request} preview={preview} loading={loading} />}
          <SheetButtons go={micros !== null ? `Give ${usd(micros)}${shared === 'shared' ? ' in total' : ' each'}` : 'Give credit'} disabled={!ready || loading || !preview?.numbers} saving={saving} onCancel={onClose} />
        </form>
      )}
    </FormSheet>
  );
}
