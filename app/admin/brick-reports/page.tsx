'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { LoadError, LoadingRows } from '../components/ds';
import type { Inbox, ProblemRow, ReportState } from '@/lib/brick-reports';
import { AREA_WORDS, KIND_WORDS, LEVEL_WORDS, STATE_WORDS, whoLine } from './brick-reports-words';
import styles from './brick-reports.module.css';

const TABS: ReportState[] = ['new', 'working', 'fixed'];

const EMPTY_WORDS: Record<ReportState, string> = {
  new: 'No new reports. When a Brick hits a wall, it lands here.',
  working: 'Nothing is being worked on.',
  fixed: 'Nothing is marked fixed yet.',
};

/**
 * Brick reports (mock "Brick reports inbox", screen 1): what Bricks hit, counted across every Brick and ranked by priority. Super admins
 * only, under Admin next to Bots. Counts only: no names and no chat words, and no screen says which Brick, owner, world or room sent a note.
 */
export default function BrickReportsPage() {
  const replacePage = useReplacePage();
  const [tab, setTab] = useState<ReportState>('new');
  const [loaded, setLoaded] = useState<Inbox | null>(null);
  // Rows are shown only for the tab now selected: a slower read of another tab is never shown under it
  const inbox = loaded && loaded.state === tab ? loaded : null;
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/brick-reports?state=${tab}`);
      if (mine !== latest.current) return;
      if (response.status === 401 || response.status === 403) {
        replacePage('/admin');
        return;
      }
      if (!response.ok) throw new Error('load');
      const next = (await response.json()) as Inbox;
      if (mine === latest.current) setLoaded(next);
    } catch {
      if (mine === latest.current) setFailed(true);
    }
  }, [tab, replacePage]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = loaded?.counts;
  return (
    <div className="grid min-w-0 gap-1" data-testid="brick-reports-page">
      <div className={styles.eyebrow}>Admin</div>
      <h1 className="orbit-display text-2xl font-bold leading-tight">Brick reports</h1>
      <p className={styles.sub}>What Bricks hit. Counts only: no names, no chat words.</p>
      <div className={styles.tabs} role="group" aria-label="Show">
        {TABS.map((state) => (
          <button key={state} type="button" className={styles.tab} aria-pressed={tab === state} onClick={() => setTab(state)} data-testid={`brick-reports-tab-${state}`}>
            {STATE_WORDS[state]}
            {counts ? ` ${counts[state].toLocaleString()}` : ''}
          </button>
        ))}
      </div>
      {failed ? (
        <LoadError label="Brick reports" retry={() => void load()} />
      ) : !inbox ? (
        <LoadingRows label="Brick reports" rows={4} />
      ) : inbox.problems.length === 0 ? (
        <p className={styles.empty} data-testid="brick-reports-empty">
          {EMPTY_WORDS[tab]}
        </p>
      ) : (
        <div className={styles.list}>
          {inbox.problems.map((problem) => (
            <ProblemLink key={problem.id} problem={problem} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProblemLink({ problem }: { problem: ProblemRow }) {
  return (
    <Link href={`/admin/brick-reports/${problem.id}`} className={styles.row} data-testid="brick-reports-row">
      <strong>{problem.title}</strong>
      <span className={styles.meta}>
        <span className={styles.chip} data-tone={problem.level === 'high' ? 'high' : undefined}>
          {LEVEL_WORDS[problem.level]}
        </span>
        {problem.cameBack && (
          <span className={styles.chip} data-tone="back">
            Came back
          </span>
        )}
        <span>
          {KIND_WORDS[problem.kind]} · {AREA_WORDS[problem.area]}
        </span>
        <span>{whoLine(problem.bricks, problem.people)}</span>
        {problem.rising && <span>Rising</span>}
      </span>
    </Link>
  );
}
