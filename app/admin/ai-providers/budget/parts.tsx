'use client';

// The pieces of the Budget page (billing consensus 18 Nov, version 2: section 3, P1 to P8): an area's card, the bar, an account's line.
// Every amount and every line comes from GET /api/admin/budget; nothing here holds a number.
import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, AudioLines, Cpu, Ear, HardDrive, Hourglass, Loader2, MessageSquare, Mic, PauseCircle, Plug, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatLine } from '../../components/ds';
import { ProviderLogo } from '../../components/ds/provider-logo';
import styles from '../../components/ds/ds.module.css';
import { cn } from '@/lib/utils';
import type { AccountView, AreaState, AreaView, LineView } from '@/lib/budget/types';
import { money, timeWords } from './format';

const AREA_ICON: Record<string, typeof Mic> = { chat: MessageSquare, speech: Mic, apps: Plug, computers: Cpu, storage: HardDrive };
const ACCOUNT_ICON: Record<string, typeof Mic> = { elevenlabs: AudioLines, soniox: Ear, composio: Plug, agent37: Cpu, r2: HardDrive };
const KIND_WORDS: Record<AccountView['kind'], string> = { balance: 'Balance', plan: 'Monthly plan', after: 'Billed after use', unknown: 'Balance unknown' };

/** Spent, set aside and where the month ends, on one bar that ends at the budget. */
export function Meter({ budget, spent, held, forecast, kept = 0 }: { budget: number; spent: number; held: number; forecast: number; kept?: number }) {
  const pct = (value: number) => Math.max(0, Math.min(100, budget > 0 ? (value / budget) * 100 : 100));
  const over = forecast > budget;
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
      <span className={cn('absolute inset-y-0 left-0 rounded-full border border-dashed', over ? 'border-amber-400/80 bg-amber-400/10' : 'border-foreground/25')} style={{ width: `${pct(forecast)}%` }} />
      <span className="absolute inset-y-0 left-0 rounded-full bg-[image:var(--brand-gradient)] opacity-45" style={{ width: `${pct(spent + held + kept)}%` }} />
      <span className="absolute inset-y-0 left-0 rounded-full bg-[image:var(--brand-gradient)]" style={{ width: `${pct(spent)}%` }} />
    </div>
  );
}

export function StatePill({ state, line }: { state: AreaState; line: string }) {
  const paused = state === 'reached' || state === 'provider';
  return (
    <span className={styles.pill} data-testid="area-state">
      {paused ? <PauseCircle size={12} aria-hidden="true" /> : state === 'capacity' ? <Hourglass size={12} aria-hidden="true" /> : <i aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', state === 'ok' ? 'bg-green-500' : 'bg-amber-500')} />}
      {line}
    </span>
  );
}

export function Facts({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-1 text-xs leading-snug text-muted-foreground">
      {items.map((fact) => (
        <li key={fact} className="flex gap-2">
          <span aria-hidden="true">·</span>
          <span>{fact}</span>
        </li>
      ))}
    </ul>
  );
}

/** How the forecast was read: the days it looked at, when, and whether it had little to go on or one day carried it. Said openly, never hidden. */
export function ReadingLine({ area }: { area: AreaView }) {
  const reading = area.reading;
  if (!reading) return null;
  const notes = [`Read from the last ${reading.sampleDays} day${reading.sampleDays === 1 ? '' : 's'} at ${timeWords(reading.readAt)}`];
  if (reading.sparse) notes.push(`only ${reading.daysWithUse} of them had use, so there is little to go on`);
  if (reading.burst) notes.push('one day carried most of it: a burst can reach the budget sooner');
  return (
    <span className="text-[11px] leading-snug text-muted-foreground/80" data-testid={`area-${area.key}-reading`}>
      {notes.join(' · ')}
    </span>
  );
}

export function AreaCard({ area, onRaise, onCapacity, lastChange }: { area: AreaView; onRaise: (area: AreaView, line?: LineView) => void; onCapacity: () => void; lastChange?: string | null }) {
  const Icon = AREA_ICON[area.key] ?? Mic;
  const warn = area.state !== 'ok';
  const raiseFirst = area.state === 'reached' || area.state === 'low';
  const budget = area.budgetMicros;
  const kept = area.key === 'computers' && budget !== null && area.usedPercent !== null ? Math.max(0, (area.usedPercent / 100) * budget - area.spentMicros - area.heldMicros) : 0;
  return (
    <article className={cn(styles.card, 'content-start hover:transform-none')} data-testid={`area-${area.key}`} style={warn && area.state !== 'not_set' ? { borderColor: 'rgb(245 158 11 / 0.45)' } : undefined}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-content-center rounded-xl bg-foreground/[.06]">
          <Icon size={20} aria-hidden="true" />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="orbit-display text-base font-bold">{area.title}</h3>
            <StatePill state={area.state} line={area.stateLine} />
          </div>
          <span className="text-xs leading-snug text-muted-foreground">{area.covers}</span>
        </div>
      </div>

      <div className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm">
            <strong className="orbit-display text-xl font-bold tabular-nums">{money(area.spentMicros)}</strong>
            <span className="text-muted-foreground">{budget === null ? ' spent' : ` of ${money(budget)}`}</span>
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {area.heldMicros > 0 && `${money(area.heldMicros)} set aside · `}
            {`${money(area.forecastMicros)} by the month’s end`}
          </span>
        </div>
        {budget !== null && <Meter budget={budget} spent={area.spentMicros} held={area.heldMicros} forecast={area.forecastMicros} kept={kept} />}
        <ReadingLine area={area} />
        {lastChange && <span className="text-[11px] leading-snug text-muted-foreground/80">{lastChange}</span>}
      </div>

      {area.lines && (
        <ul className="grid gap-1 rounded-xl bg-foreground/[.03] p-1.5">
          {area.lines.map((line) => (
            <li key={line.key} className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2.5 py-1 text-sm" data-testid={`line-${line.key}`}>
              <span className="grid min-w-0">
                <span className="font-medium">{line.title}</span>
                <StatLine items={[line.budgetMicros === null ? `${money(line.spentMicros)} spent, no budget set` : `${money(line.spentMicros)} of ${money(line.budgetMicros)}`, ...line.facts]} />
              </span>
              <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => onRaise(area, line)} data-testid={`raise-${line.key}`}>
                {line.budgetMicros === null ? 'Set' : 'Raise'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Facts items={area.facts} />

      {area.flag && (
        <p className="flex items-start gap-2 rounded-xl bg-foreground/[.04] px-3 py-2 text-xs leading-snug" data-testid={`area-${area.key}-flag`}>
          <AlertTriangle size={14} aria-hidden="true" className="mt-px shrink-0 text-amber-400" />
          {area.flag}
        </p>
      )}

      {area.ifPaused && (
        <p className="grid gap-0.5 rounded-xl border border-foreground/10 px-3 py-2 text-xs leading-snug" data-testid={`area-${area.key}-paused`}>
          <span>
            <strong className="font-semibold">{area.state === 'capacity' ? 'Now: ' : area.state === 'reached' || area.state === 'provider' ? 'Paused now: ' : 'If it pauses: '}</strong>
            {area.ifPaused.stops}
          </span>
          <span className="text-muted-foreground">{area.ifPaused.stillCosts}</span>
        </p>
      )}

      {area.key !== 'chat' && (
        <div className="flex flex-wrap gap-2">
          {area.state === 'provider' && area.topUp && (
            <Button asChild className="h-11 px-5">
              <a href={area.topUp.url} target="_blank" rel="noreferrer">
                Top up at {area.topUp.name}
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            </Button>
          )}
          {area.capacity && (
            <Button variant={area.state === 'capacity' ? 'default' : 'outline'} className="h-11 px-5" onClick={onCapacity} data-testid={`capacity-${area.key}`}>
              Jobs at once
            </Button>
          )}
          {!area.lines && area.numberId && (
            <Button variant={raiseFirst ? 'default' : 'outline'} className="h-11 px-5" onClick={() => onRaise(area)} data-testid={`raise-${area.key}`}>
              {budget === null ? 'Set a budget' : 'Raise'}
            </Button>
          )}
          {area.tidy && (
            <Button asChild variant="outline" className="h-11 px-5">
              <Link href="/admin/bots" data-testid="storage-tidy">
                Pack away or delete
              </Link>
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/** One company: what it holds in the status that fits it, when it was last read, and where to top up. Unknown is never shown as zero. */
export function AccountLine({ account, onVerify, checking, onConnect, onAddFunds }: { account: AccountView; onVerify: (account: AccountView) => void; checking: boolean; onConnect?: (account: AccountView) => void; onAddFunds?: (account: AccountView) => void }) {
  const Glyph = ACCOUNT_ICON[account.key] ?? Mic;
  const icon =
    account.key === 'deepseek' ? (
      <ProviderLogo info={{ logo: 'deepseek' }} size={24} slot={40} />
    ) : (
      <span className="grid h-10 w-10 shrink-0 place-content-center">
        <Glyph size={22} aria-hidden="true" />
      </span>
    );
  const warn = account.state === 'low' || account.state === 'zero' || account.state === 'error' || account.overdue;
  const notConnected = account.connection?.connected === false;
  const amount = account.balanceMicros !== null ? money(account.balanceMicros) : account.planLeftPercent !== null ? `${Math.round(account.planLeftPercent)}% left` : null;
  const stamp = account.checkedAt ? `${account.checkedBy === 'ours' ? 'Our count' : 'Checked'} ${timeWords(account.checkedAt)}` : 'Not read yet';
  return (
    <div className={styles.row} data-tone={warn ? 'waiting' : undefined} data-testid={`account-${account.key}`}>
      {icon}
      <div className={styles.rowText}>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="text-sm font-semibold">{account.name}</strong>
          {amount && <span className="text-sm font-bold tabular-nums">{amount}</span>}
          <span className={styles.pill}>{account.state === 'zero' ? 'Empty' : account.state === 'error' ? 'Could not read' : KIND_WORDS[account.kind]}</span>
        </span>
        <StatLine items={[account.paysFor, stamp]} />
        <span className={cn('text-xs leading-snug', account.overdue ? 'text-red-400' : warn ? 'text-amber-300' : 'text-foreground/85')} data-testid={`account-${account.key}-line`}>
          {account.line}
        </span>
        {account.facts.length > 0 && <Facts items={account.facts} />}
      </div>
      <div className={cn(styles.trailing, 'flex flex-wrap justify-end gap-2')}>
        {account.connection && onConnect && (
          <Button variant={notConnected ? 'default' : 'outline'} className="h-11 px-4" onClick={() => onConnect(account)} data-testid={`connect-${account.key}`}>
            {notConnected ? 'Connect' : 'Change key'}
          </Button>
        )}
        {account.addFunds && onAddFunds && (
          <Button variant="outline" className="h-11 px-4" onClick={() => onAddFunds(account)} data-testid={`funds-${account.key}`}>
            Add funds
          </Button>
        )}
        {account.canVerify && !notConnected && (
          <Button variant="outline" className="h-11 px-4" onClick={() => onVerify(account)} disabled={checking} data-testid={`verify-${account.key}`} aria-label={`Check ${account.name} again`}>
            {checking ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
            Check again
          </Button>
        )}
        {account.kind !== 'after' && (
          <Button asChild variant="outline" className="h-11 px-4">
            <a href={account.url} target="_blank" rel="noreferrer" aria-label={`Open ${account.name} billing`}>
              {account.kind === 'balance' && !account.addFunds ? 'Top up' : 'Billing'}
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

