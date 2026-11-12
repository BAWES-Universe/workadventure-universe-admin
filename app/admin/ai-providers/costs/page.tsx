'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { Context, EntityRow, Figure, Figures, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../components/ds';
import { WokaAvatar } from '../../components/profile-card';
import styles from '../../components/ds/ds.module.css';
import { amountWords, computerTime, day, didLine, dollars, givenDates, givenPill, goesLines } from '@/lib/costs-words';
import type { CostsReport, Sure } from '@/lib/meter-costs';

/** How sure a figure is: the same quiet pill as Public and Private. */
function SurePill({ how }: { how: Sure }) {
  return <span className={styles.pill}>{how}</span>;
}

/** A row that leads nowhere: the same card as a list row, without the arrow. */
function Line({ title, context, aside, testId }: { title: string; context?: ReactNode; aside?: ReactNode; testId?: string }) {
  return (
    <div className={styles.row} data-testid={testId}>
      <div className={styles.rowText}>
        <strong className="text-sm font-semibold leading-snug">{title}</strong>
        {context}
      </div>
      {aside && <div className={styles.aside}>{aside}</div>}
    </div>
  );
}

const dayInput = (date: Date) => date.toISOString().slice(0, 10);

/** The page a super admin opens to see what Universe AI costs us (game #1999), from the meter's books. */
export default function CostsPage() {
  const replacePage = useReplacePage();
  const today = new Date();
  const [range, setRange] = useState({ from: dayInput(new Date(today.getTime() - 6 * 86400000)), to: dayInput(today) });
  const [report, setReport] = useState<CostsReport | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/meter-costs?from=${range.from}&to=${range.to}`);
      if (response.status === 401 || response.status === 403) {
        replacePage('/admin');
        return;
      }
      if (!response.ok) throw new Error('load');
      setReport((await response.json()) as CostsReport);
    } catch {
      setFailed(true);
    }
  }, [range.from, range.to, replacePage]);

  useEffect(() => {
    if (range.from && range.to && range.from <= range.to) load();
  }, [load, range.from, range.to]);

  const asked = report?.asked ?? [];
  const given = report?.given ?? [];

  return (
    <div className="grid min-w-0 gap-6" data-testid="costs-page">
      <PageHeader
        kind="provider"
        title="Costs"
        context={<span className="text-sm text-muted-foreground">What Universe AI costs us, by person, Brick and day.</span>}
        stats={
          report && (
            <Figures>
              <Figure value={dollars(report.totals.costMicros)} label="cost to us" />
              <Figure value={report.totals.people} label="people" />
              <Figure value={report.totals.guests} label="guests" />
              <Figure value={report.totals.bricks} label="Bricks" />
              <Figure value={report.totals.computers} label="computers" />
            </Figures>
          )
        }
      />

      <section aria-labelledby="costs-range" className="min-w-0 rounded-2xl border bg-card p-4 sm:p-5">
        <h2 id="costs-range" className="sr-only">
          Dates
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="from">From</Label>
            <Input id="from" type="date" className="h-11" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" className="h-11" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} />
          </div>
        </div>
      </section>

      {failed ? (
        <LoadError label="the costs" retry={load} />
      ) : !report ? (
        <LoadingRows label="the costs" rows={4} />
      ) : (
        <>
          <section aria-labelledby="costs-goes" className="min-w-0" data-testid="costs-goes">
            <SectionHeader id="costs-goes" title="Our count and theirs" />
            <div className="grid min-w-0 gap-0.5">
              {report.goes.map((row) => (
                <Line key={row.key} testId={`costs-goes-${row.key}`} title={row.title} context={<StatLine items={goesLines(row)} />} aside={<SurePill how={row.sure} />} />
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Measured: we counted it and the provider gave its own figure. Estimated: we counted it with a price from a list. Paid by someone else: on a person’s own key. Unknown: nothing to price it with yet. “Settled” is what the provider has settled so far.
            </p>
          </section>

          <section aria-labelledby="costs-people" className="min-w-0" data-testid="costs-people">
            <SectionHeader id="costs-people" title="By person" count={report.people.total} />
            <div className="grid min-w-0 gap-0.5">
              {report.people.rows.map((person) => (
                <EntityRow
                  key={person.id}
                  href={`/admin/users/${person.id}`}
                  kind="people"
                  chevron
                  leading={<WokaAvatar layers={person.woka} name={person.name} size={40} />}
                  title={person.name}
                  context={<StatLine items={[dollars(person.costMicros), `${person.bricks} ${person.bricks === 1 ? 'Brick' : 'Bricks'}`, person.extraUntil && `Extra usage until ${day(person.extraUntil)}`]} />}
                  meta={<StatLine items={didLine(person)} />}
                />
              ))}
            </div>
            {report.people.total === 0 && <p className="text-sm text-muted-foreground">Nothing recorded in these dates.</p>}
            {report.people.more.count > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">
                {report.people.more.count.toLocaleString('en')} more {report.people.more.count === 1 ? 'person' : 'people'} · {dollars(report.people.more.costMicros)}
              </p>
            )}
          </section>

          <section aria-labelledby="costs-asked" className="min-w-0" data-testid="costs-asked">
            <SectionHeader id="costs-asked" title="Asked for more" count={asked.length} />
            <div className="grid min-w-0 gap-0.5">
              {asked.map((person) => (
                <EntityRow
                  key={person.personId}
                  href={`/admin/users/${person.personId}`}
                  kind="people"
                  chevron
                  leading={<WokaAvatar layers={person.woka} name={person.name} size={40} />}
                  title={person.name}
                  context={<StatLine items={[askedWhen(person.askedAt), 'Computer time is used up for this month']} />}
                />
              ))}
            </div>
            {asked.length === 0 && <p className="text-sm text-muted-foreground">Nobody is waiting.</p>}
          </section>

          <section aria-labelledby="costs-given" className="min-w-0" data-testid="costs-given">
            <SectionHeader id="costs-given" title="Extra usage given" count={given.length} />
            <div className="grid min-w-0 gap-0.5">
              {given.map((gift) => (
                <EntityRow
                  key={gift.grantKey}
                  href={`/admin/users/${gift.personId}`}
                  kind="people"
                  chevron
                  leading={<WokaAvatar layers={gift.woka} name={gift.name} size={40} />}
                  title={gift.name}
                  context={<StatLine items={[amountWords(gift), givenDates(gift)]} />}
                  meta={<StatLine items={[`${dollars(gift.aboveUsualMicros)} above the usual so far`, `given by ${gift.givenByName}`]} />}
                  aside={<span className={styles.pill}>{givenPill(gift)}</span>}
                />
              ))}
            </div>
            {given.length === 0 && <p className="text-sm text-muted-foreground">Nothing has been given.</p>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Use this list to bill by hand until payments are set up. A gift is never owed. “To bill” stays until you mark it billed on the person’s page. “Above the usual” is what it has cost us so far, in computer time.
            </p>
          </section>

          <section aria-labelledby="costs-bricks" className="min-w-0" data-testid="costs-bricks">
            <SectionHeader id="costs-bricks" title="By Brick" count={report.bricks.total} />
            <div className="grid min-w-0 gap-0.5">
              {report.bricks.rows.map((brick) => (
                <EntityRow
                  key={brick.id}
                  href={`/admin/bots/${brick.id}`}
                  kind="bot"
                  chevron
                  title={brick.name}
                  context={brick.ownerName && brick.ownerId ? <Context parts={[{ label: brick.ownerName, kind: 'people' }]} /> : undefined}
                  meta={
                    <StatLine
                      items={
                        brick.sure === 'Paid by someone else'
                          ? [`${brick.ownKeyReplies.toLocaleString('en')} ${brick.ownKeyReplies === 1 ? 'reply' : 'replies'} on their own key`]
                          : [dollars(brick.costMicros), ...didLine(brick)]
                      }
                    />
                  }
                  aside={brick.sure === 'Paid by someone else' ? <SurePill how="Paid by someone else" /> : undefined}
                />
              ))}
            </div>
            {report.bricks.total === 0 && <p className="text-sm text-muted-foreground">No Brick did anything in these dates.</p>}
            {report.bricks.more.count > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">
                {report.bricks.more.count.toLocaleString('en')} more {report.bricks.more.count === 1 ? 'Brick' : 'Bricks'} · {dollars(report.bricks.more.costMicros)}
              </p>
            )}
          </section>

          <section aria-labelledby="costs-ways" className="min-w-0" data-testid="costs-ways">
            <SectionHeader id="costs-ways" title="By what a Brick did" />
            <div className="grid min-w-0 gap-0.5">
              {report.ways.map((way) => (
                <Line
                  key={way.key}
                  title={way.title}
                  context={
                    <StatLine
                      items={[
                        dollars(way.costMicros),
                        way.key === 'answered' && `${way.replies.toLocaleString('en')} ${way.replies === 1 ? 'reply' : 'replies'}`,
                        way.key === 'app' && `${way.appUses.toLocaleString('en')} ${way.appUses === 1 ? 'app use' : 'app uses'}`,
                        way.key === 'computer' && `${way.jobs.toLocaleString('en')} ${way.jobs === 1 ? 'job' : 'jobs'}`,
                        way.key === 'computer' && computerTime(way.computerSeconds),
                      ]}
                    />
                  }
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="costs-guests" className="min-w-0" data-testid="costs-guests">
            <SectionHeader id="costs-guests" title="Bricks for guests, by universe" />
            <div className="grid min-w-0 gap-0.5">
              {report.guests.map((universe) => (
                <EntityRow
                  key={universe.universeKey}
                  href={universe.universeKey === 'outside' ? '/admin/ai-providers/costs' : `/admin/universes/${universe.universeKey}`}
                  kind="universe"
                  universeId={universe.universeKey === 'outside' ? undefined : universe.universeKey}
                  chevron
                  title={universe.name}
                  context={<StatLine items={[dollars(universe.costMicros), `${universe.guests.toLocaleString('en')} ${universe.guests === 1 ? 'guest' : 'guests'}`, `${universe.replies.toLocaleString('en')} ${universe.replies === 1 ? 'reply' : 'replies'}`]} />}
                />
              ))}
            </div>
            {report.guests.length === 0 && <p className="text-sm text-muted-foreground">No guest used a Brick in these dates.</p>}
          </section>

          <section aria-labelledby="costs-days" className="min-w-0" data-testid="costs-days">
            <SectionHeader id="costs-days" title="By day" />
            <ul className="grid min-w-0 gap-1 rounded-2xl border bg-card p-2">
              {report.days.map((entry) => (
                <li key={entry.day} className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl px-3 text-sm">
                  <span className="min-w-0">{new Date(`${entry.day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</span>
                  <span className="flex flex-none items-baseline gap-3">
                    <span className="text-xs text-muted-foreground">
                      {entry.people.toLocaleString('en')} {entry.people === 1 ? 'person' : 'people'}
                    </span>
                    <strong className="w-14 text-right font-semibold tabular-nums">{dollars(entry.costMicros)}</strong>
                  </span>
                </li>
              ))}
            </ul>
            {report.days.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded in these dates.</p>}
          </section>
        </>
      )}
    </div>
  );
}

/** "Today at 1:05 PM" for today, the day for an earlier one. */
function askedWhen(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString() ? `Today at ${time}` : `${day(iso)} at ${time}`;
}
