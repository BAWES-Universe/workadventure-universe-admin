'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Cpu, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PickCard, PickChip, Radio } from '@/components/ui/choice';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { Figure, Figures, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../components/ds';
import styles from '../../components/ds/ds.module.css';
import { dollars } from '@/lib/costs-words';
import { GITHUB_APP_KEY, askedLine, byRouteLine, costLine, costTotalLabel, costTotalNote, dayWords, githubAppWords, runsOnWords, sheetLine, usesLine } from '@/lib/app-demand-words';
import type { AppRow, DemandReport } from '@/lib/app-demand';
import type { AppRouteName } from '@/lib/app-routes';

const RANGES = [7, 30, 90];

/** Whether Universe's own GitHub App is made (game #2041). `null` while it is being read, or when it could not be read: the page then offers the setup, which says so itself when the App is already made. */
type GitHubApp = { made: boolean; slug?: string; url?: string } | null;

/** The page a super admin opens to see which Apps are used and wanted (spec "Paying for Apps", section 22), and to choose what each runs on (section 21). */
export default function AppsDemandPage() {
  const replacePage = useReplacePage();
  const [days, setDays] = useState(30);
  const [loaded, setReport] = useState<DemandReport | null>(null);
  // Figures are shown only for the days now selected: a report of other days that is still on screen while the new one is read is not shown under them
  const report = loaded && loaded.days === days ? loaded : null;
  const [failed, setFailed] = useState(false);
  const [open, setOpenKey] = useState<string | null>(null);
  // What a refused save said. It lives here, not in the sheet: reading the page again after a stale save makes a new sheet (it is keyed by the App's version), which would clear it before it is read
  const [note, setNote] = useState<string | null>(null);
  // Which opening of a sheet this is. Every open and every close makes a new one, so a save that finishes late can only touch the
  // opening it started in: not another App's sheet, and not a sheet of the same App opened again after it was closed
  const opening = useRef(0);
  const setOpen = (key: string | null) => {
    setNote(null);
    opening.current += 1;
    setOpenKey(key);
  };
  // Only the latest read may show: a slower read of other days must not land on top of the days now showing
  const latest = useRef(0);

  // Whether Universe's GitHub App is made: read once, apart from the report, so the report never waits on it
  const [githubApp, setGitHubApp] = useState<GitHubApp>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/admin/github-app');
        if (!response.ok) return;
        const body = (await response.json()) as { made?: unknown; slug?: unknown; url?: unknown };
        if (alive && typeof body.made === 'boolean') setGitHubApp({ made: body.made, slug: typeof body.slug === 'string' ? body.slug : undefined, url: typeof body.url === 'string' ? body.url : undefined });
      } catch {
        // Not known: the sheet offers the setup anyway
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    const mine = ++latest.current;
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/apps-demand?days=${days}`);
      // A newer read has taken over (it is the one that shows), or the person is sent away: nothing here failed
      if (mine !== latest.current) return true;
      if (response.status === 401 || response.status === 403) {
        replacePage('/admin');
        return true;
      }
      if (!response.ok) throw new Error('load');
      const next = (await response.json()) as DemandReport;
      if (mine === latest.current) setReport(next);
      return true;
    } catch {
      if (mine === latest.current) setFailed(true);
      return false;
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
  const thisOpening = opening.current;

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
              <Figure value={dollars(report.totals.costMicros)} label={costTotalLabel(report.totals.cost)} />
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
          {costTotalNote(report.totals.cost) && (
            <p className="text-sm text-muted-foreground" data-testid="apps-cost-note">
              {costTotalNote(report.totals.cost)}
            </p>
          )}
          <section aria-labelledby="apps-used" className="min-w-0" data-testid="apps-used">
            <SectionHeader id="apps-used" title="Most used, by cost to us" count={report.apps.length} />
            <div className="grid min-w-0 gap-0.5">
              {report.apps.map((row) => (
                <button key={row.key} type="button" className={`${styles.row} text-left`} onClick={() => setOpen(row.key)} data-testid={`apps-row-${row.key}`}>
                  <div className={styles.rowText}>
                    <strong className="text-sm font-semibold leading-snug">{row.name}</strong>
                    <StatLine items={usesLine(row)} />
                    <StatLine items={costLine(row)} />
                    {row.key === GITHUB_APP_KEY && (
                      <span className="text-xs font-semibold text-primary" data-testid="apps-github-hint">
                        {githubApp?.made ? githubAppWords.rowHintAfter : githubAppWords.rowHintBefore}
                      </span>
                    )}
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
          {app && report && <RouteSheet key={`${app.key}:${app.routeVersion}`} app={app} githubApp={githubApp} days={report.days} note={note} onNote={(words) => opening.current === thisOpening && setNote(words)} onClose={() => opening.current === thisOpening && setOpen(null)} onSaved={() => loadRef.current()} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** One App: its numbers, and "Runs on" with the note that people see no change. */
function RouteSheet({ app, githubApp, days, note, onNote, onClose, onSaved }: { app: AppRow; githubApp: GitHubApp; days: number; note: string | null; onNote: (words: string | null) => void; onClose: () => void; onSaved: () => Promise<boolean> }) {
  const [route, setRoute] = useState<AppRouteName>(app.route);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const split = byRouteLine(app);
  const shown = error ?? note;
  const universeOff = !app.own.ready && app.route !== 'universe';
  // GitHub once Universe's own GitHub App is made: words only, the choice itself works as it always did
  const githubMade = app.key === GITHUB_APP_KEY && githubApp?.made === true;

  // A radio group moves with the arrow keys: the picked one is the one Tab stops on, and an arrow picks the next one that can be picked and focuses it
  const moveBetweenRoutes = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !back) return;
    event.preventDefault();
    const options: AppRouteName[] = universeOff ? ['composio'] : ['composio', 'universe'];
    const at = Math.max(0, options.indexOf(route));
    const next = options[(at + (forward ? 1 : -1) + options.length) % options.length];
    setRoute(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="apps-route-${next}"]`)?.focus();
  };

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
          // The page is read again first, and the words say what happened: "reloaded" only when it was
          const reloaded = await onSaved();
          if (reloaded) onNote('Someone moved this App since you opened it. It is reloaded: look again and save.');
          else setError('Someone moved this App since you opened it, and the page could not be reloaded. Close this, try loading the Apps again, then open the App again.');
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

      {app.key === GITHUB_APP_KEY && <GitHubAppPanel githubApp={githubApp} />}

      <div className="grid gap-2" role="radiogroup" aria-label="Runs on" onKeyDown={moveBetweenRoutes}>
        <h3 className="text-sm font-semibold">Runs on</h3>
        {githubMade && (
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid="apps-github-runs-on-note">
            {githubAppWords.runsOnOnly}
          </p>
        )}
        <PickCard role="radio" tabIndex={route === 'composio' ? 0 : -1} picked={route === 'composio'} indicator={<Radio checked={route === 'composio'} />} title="Composio" onClick={() => setRoute('composio')} data-testid="apps-route-composio" />
        <PickCard
          role="radio"
          tabIndex={route === 'universe' ? 0 : -1}
          picked={route === 'universe'}
          indicator={<Radio checked={route === 'universe'} />}
          title="Universe"
          description={githubMade ? githubAppWords.universeLine : app.own.ready ? (app.own.passedChecksOn ? `Our own version passed its checks on ${dayWords(app.own.passedChecksOn)}.` : undefined) : app.own.why.join(' ')}
          disabled={universeOff}
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

/**
 * GitHub's own panel in its sheet (game #2041): the one place a super admin starts Universe's GitHub App from, and, once it is made, where it
 * says so. The button goes to the setup page inside Orbit; nothing about how GitHub runs through Composio changes.
 */
function GitHubAppPanel({ githubApp }: { githubApp: GitHubApp }) {
  const made = githubApp?.made === true;
  return (
    <div className="grid gap-3 rounded-2xl border bg-card p-3" data-testid="apps-github-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{githubAppWords.title}</h3>
        {made && (
          <span className={styles.pill} data-status="live" data-testid="apps-github-status">
            <i className={styles.statusDot} aria-hidden="true" />
            {githubAppWords.madeStatus}
          </span>
        )}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground" data-testid="apps-github-text">
        {made ? githubAppWords.made : githubAppWords.notMade}
      </p>
      {made ? (
        <>
          {githubApp?.url && githubApp.slug && (
            <a className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary" href={githubApp.url} target="_blank" rel="noreferrer" data-testid="apps-github-open">
              {githubAppWords.openOnGitHub}: {githubApp.slug}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </>
      ) : (
        <div>
          <Button asChild className="h-11" data-testid="apps-github-setup">
            <Link href="/admin/github-app">{githubAppWords.button}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
