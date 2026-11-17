'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { FormSheet } from './form-sheet';
import { LoadError, LoadingRows, SectionHeader } from './ds';
import styles from './ds/ds.module.css';
import { CAPABILITY_ABOUT, PAUSE_NOTE } from '@/lib/capability-pause-words';
import type { Capability } from '@/lib/capability-pause';

export interface PauseRow {
  key: Capability;
  name: string;
  paused: boolean;
  reason: string | null;
  words: string | null;
  at: string | null;
  jobsLeft?: number;
  machinesLeft?: number;
}

/** Whether a pause answer is one the page can show (each row needs its name and whether it is paused). */
export function readPauses(answer: unknown): PauseRow[] | null {
  const list = (answer as { capabilities?: unknown } | null)?.capabilities;
  if (!Array.isArray(list)) return null;
  const rows = list.filter((row): row is PauseRow => !!row && typeof row === 'object' && typeof (row as PauseRow).key === 'string' && typeof (row as PauseRow).name === 'string' && typeof (row as PauseRow).paused === 'boolean');
  return rows.length === list.length ? rows : null;
}

/** "since 3:12 PM" (or the day, when it is not today), in the viewer's own time. */
function since(at: string | null): string | null {
  if (!at) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const today = new Date().toDateString() === when.toDateString();
  return `since ${today ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : when.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

function StatePill({ paused }: { paused: boolean }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/15 px-2.5 text-[11px] font-semibold text-foreground/85">
      <i aria-hidden="true" className={paused ? 'h-1.5 w-1.5 rounded-full bg-amber-500' : 'h-1.5 w-1.5 rounded-full bg-green-500'} />
      {paused ? 'Paused' : 'Running'}
    </span>
  );
}

async function send(url: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const { authenticatedFetch } = await import('@/lib/client-auth');
    const response = await authenticatedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: (data as { error?: string } | null)?.error || 'That didn’t work. Try again.' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'That didn’t work. Check your connection and try again.' };
  }
}

/**
 * Pause now, for each paid capability on its own (Instant Apps, Apps, Computers). One row each, one button, taking hold at once.
 * Super admins only (the Universe AI page is theirs). Nothing here is a setting for people: they only ever meet a kind line from their Brick.
 */
export function CapabilityPauses() {
  const { addToast } = useToast();
  const [rows, setRows] = useState<PauseRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  // One count for every read and every command: an answer is only shown when nothing newer was started after it, so a slow read that began
  // before a command can never put back what that command changed
  const latest = useRef(0);

  async function load() {
    const mine = ++latest.current;
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch('/api/admin/capability-pause');
      if (!response.ok) throw new Error('load');
      const next = readPauses(await response.json());
      if (!next) throw new Error('shape');
      if (mine === latest.current) setRows(next);
    } catch {
      if (mine === latest.current) setFailed(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function change(row: PauseRow, action: 'pause' | 'resume') {
    setBusy(row.key);
    const mine = ++latest.current;
    const result = await send('/api/admin/capability-pause', { capability: row.key, action });
    setBusy(null);
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      // The count moved on when this was sent, so a read that was still on its way is dropped: read again, or the screen keeps what that read was to show
      void load();
      return;
    }
    const next = readPauses(result.data);
    if (next && mine === latest.current) setRows(next);
    addToast({ description: `${row.name} ${action === 'pause' ? 'paused' : 'resumed'}`, variant: 'success', duration: 2500 });
  }

  async function endRunning() {
    setBusy('computers');
    latest.current++;
    const result = await send('/api/admin/computer/wind-down', { action: 'start' });
    setBusy(null);
    setEnding(false);
    if (!result.ok) {
      addToast({ description: result.error, variant: 'error' });
      void load();
      return;
    }
    addToast({ description: 'Ending every job on computers now', variant: 'success', duration: 2500 });
    void load();
  }

  const computers = rows?.find((row) => row.key === 'computers');

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="pause" data-testid="capability-pauses">
      <SectionHeader id="pause" title="Pause" />
      {failed ? (
        <LoadError label="the pauses" retry={load} />
      ) : !rows ? (
        <LoadingRows label="the pauses" rows={3} />
      ) : (
        <>
          <div className="grid min-w-0 gap-2">
            {rows.map((row) => {
              const going = row.key === 'computers' ? (row.jobsLeft ?? 0) : 0;
              return (
                <div
                  key={row.key}
                  className="grid min-w-0 gap-3 rounded-[18px] border border-border bg-card p-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  data-testid={`pause-${row.key}`}
                  data-paused={row.paused ? 'yes' : 'no'}
                >
                  <div className="grid min-w-0 gap-1">
                    <div className={styles.titleLine}>
                      <strong className="text-sm font-semibold leading-snug">{row.name}</strong>
                      <StatePill paused={row.paused} />
                    </div>
                    <span className="text-xs leading-snug text-muted-foreground">{CAPABILITY_ABOUT[row.key]}</span>
                    {row.paused && (
                      <span className="text-xs leading-snug text-foreground/85" data-testid={`pause-${row.key}-words`}>
                        {[row.words ?? 'Paused', since(row.at)].filter(Boolean).join(' · ')}
                        {going > 0 ? ` · ${going === 1 ? '1 job' : `${going} jobs`} not finished` : ''}
                      </span>
                    )}
                  </div>
                  <Button
                    variant={row.paused ? 'default' : 'outline'}
                    className="h-11 w-full sm:w-auto sm:min-w-28"
                    disabled={busy !== null}
                    onClick={() => void change(row, row.paused ? 'resume' : 'pause')}
                    aria-label={`${row.paused ? 'Resume' : 'Pause'} ${row.name}`}
                  >
                    {busy === row.key && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {row.paused ? 'Resume' : 'Pause'}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{PAUSE_NOTE}</p>
          {computers?.paused && (computers.jobsLeft ?? 0) + (computers.machinesLeft ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-border bg-card px-3.5 py-3" data-testid="pause-end-running">
              <span className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
                {(computers.jobsLeft ?? 0) === 1 ? '1 job is' : `${computers.jobsLeft ?? 0} jobs are`} not finished on computers. They finish by themselves, or you can end them now.
              </span>
              <Button variant="outline" className="h-11" disabled={busy !== null} onClick={() => setEnding(true)}>
                End them now
              </Button>
            </div>
          )}
        </>
      )}
      <FormSheet open={ending} onOpenChange={(open) => !open && busy === null && setEnding(false)} title="End every job on computers now?">
        <p className="text-sm text-muted-foreground">
          Every job on a computer ends now, the files each one made are saved, and every machine stops. Nothing already made is lost. Resume brings computers back.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 px-5" disabled={busy !== null} onClick={() => setEnding(false)}>
            Cancel
          </Button>
          <Button className="h-11 px-5" disabled={busy !== null} onClick={() => void endRunning()}>
            {busy === 'computers' ? 'Ending…' : 'End them now'}
          </Button>
        </div>
      </FormSheet>
    </section>
  );
}
