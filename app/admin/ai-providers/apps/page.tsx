'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PickCard, PickChip, Radio } from '@/components/ui/choice';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { Figure, Figures, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../components/ds';
import styles from '../../components/ds/ds.module.css';
import { dollars } from '@/lib/costs-words';
import { askedLine, byRouteLine, costLine, dayWords, runsOnWords, sheetLine, usesLine } from '@/lib/app-demand-words';
import type { AppRow, DemandReport } from '@/lib/app-demand';
import type { AppRouteName } from '@/lib/app-routes';

const RANGES = [7, 30, 90];

/** The page a super admin opens to see which Apps are used and wanted (spec "Paying for Apps", section 22), and to choose what each runs on (section 21). */
export default function AppsDemandPage() {
  const replacePage = useReplacePage();
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<DemandReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpenKey] = useState<string | null>(null);
  // What a refused save said. It lives here, not in the sheet: reading the page again after a stale save makes a new sheet (it is keyed by the App's version), which would clear it before it is read
  const [note, setNote] = useState<string | null>(null);
  // Which App's sheet is open right now: a save that finishes late must only touch its own sheet
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  const setOpen = (key: string | null) => {
    setNote(null);
    openRef.current = key;
    setOpenKey(key);
  };
  // Only the latest read may show: a slower read of other days must not land on top of the days now showing
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/apps-demand?days=${days}`);
      if (mine !== latest.current) return;
      if (response.status === 401 || response.status === 403) {
        replacePage('/admin');
        return;
      }
      if (!response.ok) throw new Error('load');
      const next = (await response.json()) as DemandReport;
      if (mine === latest.current) setReport(next);
    } catch {
      if (mine === latest.current) setFailed(true);
    }
  }, [days, replacePage]);

  useEffect(() => {
    setReport(null);
    load();
  }, [load]);

  // A save can finish after the days were changed: it must read the days now shown, not the days it started with
  const loadRef = useRef(load);
  loadRef.current = load;

  const app = report?.apps.find((row) => row.key === open) ?? null;

  return (
    <div className="grid min-w-0 gap-6" data-testid="apps-demand-page">
      <PageHeader
        icon={<Cpu size={30} aria-hidden="true" />}
        title="Apps: use and demand"
        context={<span className="text-sm text-muted-foreground">Which Apps people use, what each costs us, and what they asked for that we don’t have yet.</span>}
        stats={
          report && (
            <Figures>
              <Figure value={report.totals.uses.toLocaleString('en')} label="uses" />
              <Figure value={report.totals.people.toLocaleString('en')} label="people" />
              <Figure value={dollars(report.totals.costMicros)} label="cost to us" />
              <Figure value={report.totals.asks.toLocaleString('en')} label="asked for more" />
            </Figures>
          )
        }
        actions={
          <>
            <Button asChild variant="outline" className="h-11">
              <Link href="/admin/ai-providers/costs">Costs</Link>
            </Button>
            {RANGES.map((range) => (
              <PickChip key={range} picked={days === range} onClick={() => setDays(range)} data-testid={`apps-range-${range}`}>
                Last {range} days
              </PickChip>
            ))}
          </>
        }
      />

      {failed ? (
        <LoadError label="the Apps" retry={load} />
      ) : !report ? (
        <LoadingRows label="the Apps" rows={4} />
      ) : (
        <>
          <section aria-labelledby="apps-used" className="min-w-0" data-testid="apps-used">
            <SectionHeader id="apps-used" title="Most used, by cost to us" count={report.apps.length} />
            <div className="grid min-w-0 gap-0.5">
              {report.apps.map((row) => (
                <button key={row.key} type="button" className={`${styles.row} text-left`} onClick={() => setOpen(row.key)} data-testid={`apps-row-${row.key}`}>
                  <div className={styles.rowText}>
                    <strong className="text-sm font-semibold leading-snug">{row.name}</strong>
                    <StatLine items={usesLine(row)} />
                    <StatLine items={costLine(row)} />
                  </div>
                  <div className={styles.aside}>
                    <span className={styles.pill} data-testid={`apps-runs-on-${row.key}`}>
                      {runsOnWords(row.route)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            {report.apps.length === 0 && <p className="text-sm text-muted-foreground">No Apps have been used in these days.</p>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              “Instant” Apps work without connecting anything and use people’s Instant Apps credit. Apps on their own account stay free for them; the small cost here is ours. Tap an App to see more or change what it runs on.
            </p>
          </section>

          <section aria-labelledby="apps-asked" className="min-w-0" data-testid="apps-asked">
            <SectionHeader id="apps-asked" title="Asked for, not available yet" count={report.asked.length + report.askedMore} />
            <div className="grid min-w-0 gap-0.5">
              {report.asked.map((row) => (
                <div key={row.name} className={styles.row} data-testid="apps-asked-row">
                  <div className={styles.rowText}>
                    <strong className="text-sm font-semibold leading-snug">{row.name}</strong>
                    <StatLine items={[askedLine(row)]} />
                  </div>
                </div>
              ))}
            </div>
            {report.asked.length === 0 && <p className="text-sm text-muted-foreground">Nothing asked for in these days.</p>}
            {report.askedMore > 0 && <p className="mt-3 text-sm text-muted-foreground">{report.askedMore.toLocaleString('en')} more App names were asked for.</p>}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Counted when a Brick looked for an App and found none. Only the App’s name is kept, never what people wrote.</p>
          </section>
        </>
      )}

      <Sheet open={app !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent side="bottom" data-testid="apps-sheet">
          {app && report && <RouteSheet key={`${app.key}:${app.routeVersion}`} app={app} days={report.days} note={note} onNote={(words) => openRef.current === app.key && setNote(words)} onClose={() => openRef.current === app.key && setOpen(null)} onSaved={() => loadRef.current()} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** One App: its numbers, and "Runs on" with the note that people see no change. */
function RouteSheet({ app, days, note, onNote, onClose, onSaved }: { app: AppRow; days: number; note: string | null; onNote: (words: string | null) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const [route, setRoute] = useState<AppRouteName>(app.route);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const split = byRouteLine(app);
  const shown = error ?? note;

  const save = async () => {
    setSaving(true);
    setError(null);
    onNote(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/app-routes/${encodeURIComponent(app.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route, expectedVersion: app.routeVersion }),
      });
      if (response.status === 409) {
        const body = (await response.json().catch(() => null)) as { code?: string; why?: string[] } | null;
        if (body?.code === 'stale') {
          // Said once, kept by the page, then the page is read again: the sheet that opens next shows the newer state with this note
          onNote('Someone moved this App since you opened it. It is reloaded: look again and save.');
          await onSaved();
          return;
        }
        setError(body?.why?.join(' ') ?? 'Our own version is not ready to run this App yet.');
        return;
      }
      if (!response.ok) throw new Error('save');
      await onSaved();
      onClose();
    } catch {
      setError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 pb-2">
      <div className="grid gap-1">
        <SheetTitle className="text-2xl font-bold">{app.name}</SheetTitle>
        <SheetDescription>Last {days} days.</SheetDescription>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="apps-sheet-line">
        {sheetLine(app)}
      </p>
      {split && (
        <p className="text-sm text-muted-foreground" data-testid="apps-sheet-split">
          {split}
        </p>
      )}

      <div className="grid gap-2" role="radiogroup" aria-label="Runs on">
        <h3 className="text-sm font-semibold">Runs on</h3>
        <PickCard role="radio" picked={route === 'composio'} indicator={<Radio checked={route === 'composio'} />} title="Composio" onClick={() => setRoute('composio')} data-testid="apps-route-composio" />
        <PickCard
          role="radio"
          picked={route === 'universe'}
          indicator={<Radio checked={route === 'universe'} />}
          title="Universe"
          description={app.own.ready ? (app.own.passedChecksOn ? `Our own version passed its checks on ${dayWords(app.own.passedChecksOn)}.` : undefined) : app.own.why.join(' ')}
          disabled={!app.own.ready && app.route !== 'universe'}
          onClick={() => setRoute('universe')}
          data-testid="apps-route-universe"
        />
      </div>

      <p className="rounded-2xl border bg-card p-3 text-sm leading-relaxed text-muted-foreground" data-testid="apps-sheet-note">
        People see no change: same name, same price, same credit. New runs go to the one you pick, so what people pay stays with us.
        {app.onOwnVersionAtMostMicros !== null && app.byRoute.composio.uses > 0 && <> The same {app.byRoute.composio.uses.toLocaleString('en')} uses would cost us at most {dollars(app.onOwnVersionAtMostMicros)} on our own version.</>} Runs already going finish where they started. You can move it back any time.
      </p>

      {shown && (
        <p role="alert" className="text-sm text-destructive" data-testid="apps-sheet-error">
          {shown}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button className="h-11" onClick={save} disabled={saving || route === app.route} data-testid="apps-route-save">
          Save
        </Button>
      </div>
    </div>
  );
}
