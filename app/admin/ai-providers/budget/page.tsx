'use client';

// The one Budget page (billing consensus 18 Nov, version 2: section 3, P1 to P8, brief E), super admins only. Every number and every line comes
// from GET /api/admin/budget, which reads the saved settings, the books and the company accounts; the page itself holds no amount.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowUpRight, ChevronDown, Sparkles, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useToast } from '@/components/ui/toast';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { EntityRow, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../components/ds';
import { LimitGroup } from '../../components/limits';
import { WokaAvatar } from '../../components/profile-card';
import styles from '../../components/ds/ds.module.css';
import type { AccountView, AreaView, BudgetReport, ChangeView, LineView, NumberView } from '@/lib/budget/types';
import { AccountLine, AreaCard } from './parts';
import { ConnectSheet, FundsSheet } from './account-sheets';
import { RaiseSheet, walletNoteFor, type RaiseTarget } from './raise-sheet';
import { dayWords, limitOf, money, timeWords, toSaved, valueWords, whenWords } from './format';

const DETAIL_GROUPS: { group: NumberView['group']; title: string; note?: string }[] = [
  { group: 'budget', title: 'Monthly budgets', note: 'The same numbers the Raise buttons change. Any amount inside the range can be saved, up or down. It is used by the very next request.' },
  { group: 'price', title: 'Prices we count with', note: 'Used for the forecast and for what Universe may owe. Estimates say so.' },
  { group: 'person', title: 'For one person, a month', note: 'Keeps one runaway loop from using everyone’s budget. Reaching one offers Ask for more, and Give more lifts it for that person.' },
  { group: 'capacity', title: 'Jobs at once', note: 'Capacity, not money. A job past these waits in line with its place shown, then starts by itself.' },
  { group: 'reserve', title: 'Kept back' },
  { group: 'credit', title: 'Credit and give-backs', note: 'What Universe funds and returns. None of these has a built-in value: each is yours to set.' },
  { group: 'instant', title: 'Instant Apps checks', note: 'How Instant Apps watch themselves, and when they pause by themselves.' },
  { group: 'warning', title: 'Warnings', note: 'When Orbit tells you, and how often it looks.' },
  { group: 'forecast', title: 'How forecasts and suggestions are worked', note: 'What a forecast reads from and how big a suggested raise is.' },
];

/** After a payment link is opened, how often the company is read again and for how many reads (about three minutes) before the page stops asking. */
const WATCH_EVERY_MS = 10_000;
const WATCH_TICKS = 18;

export default function BudgetPage() {
  const replacePage = useReplacePage();
  const params = useSearchParams();
  const { addToast } = useToast();
  const [report, setReport] = useState<BudgetReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [raising, setRaising] = useState<RaiseTarget | null>(null);
  const [details, setDetails] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, string>>({});
  const [allChanges, setAllChanges] = useState<ChangeView[] | null>(null);
  const [connecting, setConnecting] = useState<AccountView | null>(null);
  const [funding, setFunding] = useState<AccountView | null>(null);
  // After a payment link is opened: the company and the balance it showed, so the page can say when it changes
  const [watching, setWatching] = useState<{ key: string; before: number | null } | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/budget');
      if (response.status === 401 || response.status === 403) {
        replacePage('/admin');
        return;
      }
      if (!response.ok) throw new Error('load');
      setReport((await response.json()) as BudgetReport);
    } catch {
      setFailed(true);
    }
  }, [replacePage]);

  useEffect(() => {
    void load();
  }, [load]);

  const numbers = useMemo(() => new Map((report?.numbers ?? []).map((entry) => [entry.id, entry])), [report]);

  const targetFor = useCallback(
    (numberId: string, suggested?: number | null): RaiseTarget | null => {
      if (!report) return null;
      const number = numbers.get(numberId);
      if (!number) return null;
      const area = report.areas.find((entry) => entry.numberId === numberId || entry.lines?.some((line) => line.numberId === numberId));
      if (!area) return null;
      const line = area.lines?.find((entry) => entry.numberId === numberId);
      const wallet = area.key === 'speech' ? walletNoteFor(report.accounts.find((account) => account.key === 'elevenlabs')) : null;
      return {
        number,
        title: line ? `${line.title} (Apps)` : `the ${area.title} budget`,
        spentMicros: line ? line.spentMicros : area.spentMicros,
        forecastMicros: line ? null : area.forecastMicros,
        runsOutAt: line ? null : area.runsOutAt,
        offers: line ? (number.value !== null ? [{ micros: Math.ceil((number.value * 1.5) / 1_000_000) * 1_000_000, words: 'Half as much again' }] : []) : area.offers,
        totalMicros: report.total.budgetMicros,
        walletNote: wallet,
        suggested,
      };
    },
    [report, numbers],
  );

  // A notice in Orbit leads here with ?raise=<number id>: the sheet is open on arrival, one tap from the warning. ?details=1 opens Details.
  const raiseParam = params.get('raise');
  useEffect(() => {
    if (report && raiseParam) {
      const target = targetFor(raiseParam);
      if (target) setRaising(target);
    }
    if (params.get('details') === '1') setDetails(true);
    // Open once per arrival, not on every refresh of the report
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raiseParam, report === null]);

  async function saveNumber(number: NumberView, micros: number | null, raw = false): Promise<{ ok: boolean; error?: string }> {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/budget/numbers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: number.id, value: micros }) });
      const data = (await response.json().catch(() => ({}))) as { error?: string; inEffect?: boolean; value?: number | null };
      if (!response.ok) return { ok: false, error: data.error ?? 'It could not be saved.' };
      // "In effect" only after the backend read the value back and it is the one that was asked for
      if (!data.inEffect) return { ok: false, error: 'It was saved, but Orbit could not confirm it is in effect. Reload the page to see what is enforced.' };
      addToast({ description: `In effect: ${number.label} is now ${valueWords(number.unit, data.value ?? micros)}${number.unit === 'micros' && !raw ? ' a month' : ''}.`, variant: 'success', duration: 4000 });
      setRaising(null);
      await load();
      setAllChanges(null);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Orbit could not be reached. Nothing was changed.' };
    }
  }

  async function verify(account: AccountView) {
    setChecking(account.key);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/budget/accounts/${encodeURIComponent(account.key)}/verify`, { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { account?: AccountView; looked?: { line: string }; error?: string };
      if (!response.ok || !data.account) {
        addToast({ description: data.error ?? `${account.name} could not be checked.`, variant: 'error' });
        return;
      }
      const fresh = data.account;
      setReport((now) => now && { ...now, accounts: now.accounts.map((entry) => (entry.key === fresh.key ? fresh : entry)) });
      setChecked((now) => ({ ...now, [fresh.key]: data.looked?.line ?? '' }));
      addToast({ description: data.looked?.line ?? `${account.name} was read again.`, variant: fresh.state === 'zero' ? 'error' : 'success', duration: 5000 });
      await load();
    } catch {
      addToast({ description: `${account.name} could not be checked.`, variant: 'error' });
    } finally {
      setChecking(null);
    }
  }

  function replaceAccount(fresh: AccountView) {
    setReport((now) => now && { ...now, accounts: now.accounts.map((entry) => (entry.key === fresh.key ? fresh : entry)) });
  }

  async function saveKey(account: AccountView, key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/budget/soniox-key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const data = (await response.json().catch(() => ({}))) as { account?: AccountView; error?: string };
      if (!response.ok || !data.account) return { ok: false, error: data.error ?? 'The key could not be saved.' };
      replaceAccount(data.account);
      addToast({ description: `${account.name} is connected: ${data.account.line}`, variant: 'success', duration: 5000 });
      setConnecting(null);
      await load();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Orbit could not be reached. Nothing was saved.' };
    }
  }

  async function removeKey(account: AccountView): Promise<{ ok: boolean; error?: string }> {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/budget/soniox-key', { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as { account?: AccountView; error?: string };
      if (!response.ok || !data.account) return { ok: false, error: data.error ?? 'The key could not be removed.' };
      replaceAccount(data.account);
      addToast({ description: `${account.name} is disconnected. Nothing else stopped.`, variant: 'success', duration: 4000 });
      setConnecting(null);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Orbit could not be reached. Nothing was changed.' };
    }
  }

  async function askForLink(account: AccountView, amountUsd: number): Promise<{ ok: boolean; error?: string; url?: string }> {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/budget/funds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: account.key, amountUsd }) });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) return { ok: false, error: data.error ?? 'No payment link was made. Nothing was charged.' };
      setWatching({ key: account.key, before: account.balanceMicros });
      window.open(data.url, '_blank', 'noopener,noreferrer');
      return { ok: true, url: data.url };
    } catch {
      return { ok: false, error: 'Orbit could not be reached. Nothing was charged.' };
    }
  }

  // After a payment link: read the company again every few seconds until the balance is not what it was, then say so and carry on with waiting work
  useEffect(() => {
    if (!watching) return;
    let ticks = 0;
    const timer = setInterval(async () => {
      ticks += 1;
      if (ticks > WATCH_TICKS) {
        setWatching(null);
        return;
      }
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/budget/accounts/${encodeURIComponent(watching.key)}/verify`, { method: 'POST' });
        const data = (await response.json().catch(() => ({}))) as { account?: AccountView; looked?: { line: string } };
        if (response.ok && data.account && data.account.balanceMicros !== watching.before) {
          setWatching(null);
          addToast({ description: `${data.account.name} now shows ${data.account.balanceMicros === null ? 'a new balance' : money(data.account.balanceMicros)}. ${data.looked?.line ?? ''}`.trim(), variant: 'success', duration: 6000 });
          await load();
        }
      } catch {
        // Try again at the next tick
      }
    }, WATCH_EVERY_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  async function showAll() {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/budget/changes?take=1000');
      if (response.ok) setAllChanges(((await response.json()) as { changes: ChangeView[] }).changes);
    } catch {
      addToast({ description: 'The full history could not be read.', variant: 'error' });
    }
  }

  if (failed) return <LoadError label="the budget" retry={load} />;
  if (!report) return <LoadingRows label="the budget" rows={5} />;

  const total = report.total;
  const chat = report.areas.find((area) => area.key === 'chat');

  function openCapacity() {
    setDetails(true);
    setTimeout(() => document.getElementById('details-capacity')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
  }

  function raise(area: AreaView, line?: LineView) {
    const id = line ? line.numberId : area.numberId;
    const target = id ? targetFor(id) : null;
    if (target) setRaising(target);
  }

  const lastChange = (numberId: string | null): string | null => {
    const entry = numberId ? numbers.get(numberId) : undefined;
    return entry?.lastChange ? `Last changed by ${entry.lastChange.by}, ${dayWords(entry.lastChange.at)}` : null;
  };
  const changes = allChanges ?? report.changes;

  return (
    <div className="grid min-w-0 gap-6" data-testid="budget-page">
      <PageHeader icon={<Wallet size={30} aria-hidden="true" />} title="Budget" context={<span className="text-sm text-muted-foreground">What Universe funds this month, and the company accounts that pay for it.</span>} />

      {report.alerts.length > 0 && (
        <div className="grid gap-2" data-testid="budget-alerts">
          {report.alerts.map((alert) => (
            <div key={alert.key} className={styles.row} style={{ alignItems: 'flex-start' }} data-tone={alert.level === 'quiet' ? undefined : 'waiting'} data-testid={`alert-${alert.key}`}>
              <AlertTriangle size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-400" />
              <div className={styles.rowText}>
                <strong className="text-sm font-semibold">{alert.title}</strong>
                <span className="text-xs leading-snug text-muted-foreground">{alert.body}</span>
                {alert.reading && (
                  <span className="text-[11px] leading-snug text-muted-foreground/80">
                    {`Based on the last ${alert.reading.sampleDays} day${alert.reading.sampleDays === 1 ? '' : 's'} · read ${timeWords(alert.reading.readAt)}${alert.reading.sparse ? ' · little to go on' : ''} · a burst can reach it sooner`}
                  </span>
                )}
                {(alert.raise || alert.topUp || alert.capacity) && (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {alert.raise && (
                      <Button
                        className="h-11 px-5"
                        onClick={() => {
                          const target = targetFor(alert.raise!.numberId, alert.raise!.toMicros);
                          if (target) setRaising(target);
                        }}
                        data-testid={`alert-${alert.key}-raise`}
                      >
                        {alert.raise.toMicros !== null ? `Raise to ${money(alert.raise.toMicros)}` : 'Raise'}
                      </Button>
                    )}
                    {alert.topUp && (
                      <Button asChild className="h-11 px-5">
                        <a href={alert.topUp.url} target="_blank" rel="noreferrer">
                          Top up at {alert.topUp.name}
                          <ArrowUpRight size={15} aria-hidden="true" />
                        </a>
                      </Button>
                    )}
                    {alert.capacity && (
                      <Button className="h-11 px-5" onClick={openCapacity} data-testid={`alert-${alert.key}-capacity`}>
                        Jobs at once
                      </Button>
                    )}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <section aria-labelledby="budget-month" className="grid gap-3 rounded-[22px] border bg-card p-4 sm:p-5" data-testid="budget-month">
        <div className="grid gap-1">
          <h2 id="budget-month" className="orbit-display text-lg font-bold leading-snug">
            Monthly budget for new funded work: <span className="tabular-nums">{money(total.budgetMicros)}</span>
          </h2>
          <span className="text-xs text-muted-foreground">
            {report.covers}
            {total.unsetAreas.length > 0 && ` No budget is set yet for ${total.unsetAreas.join(', ')}.`}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {[
            [money(total.spentMicros), 'spent so far'],
            [money(total.heldMicros), 'set aside right now'],
            [money(total.forecastMicros), 'forecast for the month'],
            [dayWords(report.monthTurns), 'the month turns'],
          ].map(([value, label]) => (
            <span key={label} className={styles.figure}>
              <strong>{value}</strong>
              <span>{label}</span>
            </span>
          ))}
        </div>
        <div className="grid gap-1 rounded-2xl bg-foreground/[.04] px-4 py-3" data-testid="budget-platform">
          <span className="text-sm">
            Projected platform cost this month: <strong className="tabular-nums">{money(total.platformMicros)}</strong>
          </span>
          <span className="text-xs leading-snug text-muted-foreground">{`Adds chat replies (about ${money(chat?.forecastMicros ?? 0)}), which keep their fair usage and no money stop. Storage already kept goes on costing even when new work pauses.`}</span>
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground" data-testid="budget-funding">
          <span>
            Gross cost so far {money(report.funding.grossMicros)}. What members fund themselves, apart: {report.funding.paidByMembersMicros > 0 ? money(report.funding.paidByMembersMicros) : 'nothing counted yet'} (own keys and their own Apps are not in the budget).
          </span>
          {report.funding.perTask.length > 0 && <span>{report.funding.perTask.map((task) => `${task.label} about ${money(task.micros)}`).join(' · ')}</span>}
        </div>
        <span className="text-[11px] text-muted-foreground/80">{`${report.basis} Read ${timeWords(report.readAt)}.`}</span>
      </section>

      <section aria-labelledby="budget-areas" className="min-w-0">
        <SectionHeader id="budget-areas" title="Areas" />
        <div className="grid gap-3 lg:grid-cols-2">
          {report.areas.map((area) => (
            <AreaCard key={area.key} area={area} onRaise={raise} onCapacity={openCapacity} lastChange={area.lines ? null : lastChange(area.numberId)} />
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          A budget is your permission for Universe to fund new work. A change is used by the very next request after you save. It never buys credit anywhere, never adds capacity, and never moves a cost to a member or a visitor. Own keys, calls between people and chat text are never counted here.
        </p>
      </section>

      <section id="asks" aria-labelledby="budget-asks" className="min-w-0" data-testid="budget-asks">
        <SectionHeader id="budget-asks" title="Asked for more" count={report.asks.length} />
        <div className="grid min-w-0 gap-0.5">
          {report.asks.map((ask) => (
            <EntityRow
              key={ask.personId + ask.area}
              href={`/admin/users/${ask.personId}`}
              kind="people"
              chevron
              leading={<WokaAvatar layers={ask.woka} name={ask.name} size={40} />}
              title={ask.name}
              context={<StatLine items={[ask.area, whenWords(ask.askedAt)]} />}
              meta={<span className="text-xs text-muted-foreground">{ask.what}. Open their page to give more.</span>}
            />
          ))}
        </div>
        {report.asks.length === 0 && <p className="text-sm text-muted-foreground">Nobody is waiting.</p>}
      </section>

      <section aria-labelledby="budget-accounts" className="min-w-0" data-testid="budget-accounts">
        <SectionHeader id="budget-accounts" title="Company accounts" />
        <div className="mb-3 grid gap-2 sm:grid-cols-2" data-testid="two-refills">
          <div className="grid gap-1 rounded-2xl border border-foreground/10 bg-foreground/[.03] px-4 py-3">
            <strong className="flex items-center gap-2 text-sm">
              <Sparkles size={15} aria-hidden="true" />
              Raise a budget
            </strong>
            <span className="text-xs leading-snug text-muted-foreground">Your permission for Universe to fund more. Here, in one tap. Used by requests after you save.</span>
          </div>
          <div className="grid gap-1 rounded-2xl border border-foreground/10 bg-foreground/[.03] px-4 py-3">
            <strong className="flex items-center gap-2 text-sm">
              <Wallet size={15} aria-hidden="true" />
              Top up a company
            </strong>
            <span className="text-xs leading-snug text-muted-foreground">Real money at that company, on their site from the link. Then press Check again: Orbit reads the new balance and carries on with work that was waiting, once each.</span>
          </div>
        </div>
        <div className="grid min-w-0 gap-0.5">
          {report.accounts.map((account) => (
            <div key={account.key} className="grid gap-0.5">
              <AccountLine account={account} onVerify={verify} checking={checking === account.key} onConnect={setConnecting} onAddFunds={setFunding} />
              {checked[account.key] && (
                <p className="px-3 pb-1 text-xs text-muted-foreground" data-testid={`verified-${account.key}`}>
                  {checked[account.key]}
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Money at one company can’t pay another. “Unknown” means the company doesn’t tell us; it is never shown as zero.</p>
      </section>

      <Collapsible open={details} onOpenChange={setDetails} asChild>
        <section aria-labelledby="budget-details" className="grid min-w-0 gap-4" data-testid="budget-details">
          <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-3 text-left" data-testid="details-toggle">
            <span className="grid gap-0.5">
              <span id="budget-details" className="orbit-display text-lg font-bold">
                Details
              </span>
              <span className="text-xs text-muted-foreground">Every number behind this page: prices we count with, what one person gets, jobs at once, what is kept back, and the warning levels.</span>
            </span>
            <ChevronDown size={18} aria-hidden="true" className={`shrink-0 transition-transform ${details ? 'rotate-180' : ''}`} />
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-4">
            {DETAIL_GROUPS.map((group) => {
              const rows = report.numbers.filter((entry) => entry.group === group.group);
              if (rows.length === 0) return null;
              return (
                <div key={group.group} id={group.group === 'capacity' ? 'details-capacity' : undefined} className="scroll-mt-24">
                  <LimitGroup
                    title={group.title}
                    note={group.note}
                    limits={rows.map(limitOf)}
                    onChange={async (id, shown) => {
                      const number = numbers.get(id);
                      if (!number) return false;
                      const result = await saveNumber(number, toSaved(number, shown), number.unit !== 'micros' || number.group !== 'budget');
                      if (!result.ok) addToast({ description: result.error ?? 'It could not be saved.', variant: 'error' });
                      return result.ok;
                    }}
                  />
                </div>
              );
            })}
          </CollapsibleContent>
        </section>
      </Collapsible>

      <section aria-labelledby="budget-changes" className="min-w-0" data-testid="budget-changes">
        <SectionHeader id="budget-changes" title="Changes" count={changes.length} />
        <ul className="grid min-w-0 gap-1 rounded-2xl border bg-card p-2">
          {changes.map((change) => (
            <li key={change.id} className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl px-3 text-sm" data-testid="change-line">
              <span className="min-w-0">
                <strong className="font-semibold">{change.by}</strong>
                {` changed ${change.label} from ${valueWords(change.unit, change.oldValue)} to ${valueWords(change.unit, change.newValue)}`}
                {change.note ? ` (${change.note})` : ''}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{`${dayWords(change.at)}, ${timeWords(change.at)}`}</span>
            </li>
          ))}
          {changes.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">Nothing has been changed yet.</li>}
        </ul>
        {allChanges === null && report.changes.length >= 100 && (
          <Button variant="outline" className="mt-3 h-11 px-4" onClick={showAll} data-testid="show-all-changes">
            Show the full history
          </Button>
        )}
      </section>

      <RaiseSheet target={raising} onClose={() => setRaising(null)} onSave={(number, micros) => saveNumber(number, micros)} />
      <ConnectSheet account={connecting} onClose={() => setConnecting(null)} onSave={saveKey} onRemove={removeKey} />
      <FundsSheet account={funding} onClose={() => setFunding(null)} onAsk={askForLink} />
    </div>
  );
}
