'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { EmptyCard, LoadError, LoadingRows } from '../../components/ds';
import type { ProblemDetail, ReportState } from '@/lib/brick-reports';
import { AREA_WORDS, KIND_WORDS, LEVEL_WORDS, STATE_WORDS, dayWords } from '../brick-reports-words';
import styles from '../brick-reports.module.css';

const MOVES: Record<ReportState, ReportState[]> = { new: ['working', 'fixed'], working: ['fixed', 'new'], fixed: ['new'] };
const MOVE_WORDS: Record<ReportState, string> = { new: 'Back to New', working: 'Working on it', fixed: 'Mark fixed' };

/**
 * One problem of the Brick reports inbox (mock screen 2): its counts, why it ranks where it does, and two notes picked at random each time,
 * so their order never hints at who sent them. Nothing here names a Brick, owner, world or room. Super admins only.
 */
export default function BrickReportPage() {
  const { id } = useParams<{ id: string }>();
  const replacePage = useReplacePage();
  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'gone' | 'failed'>('loading');
  const [moving, setMoving] = useState(false);
  const [moveFailed, setMoveFailed] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setState((now) => (now === 'ready' ? now : 'loading'));
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/brick-reports/${encodeURIComponent(id)}`);
      if (mine !== latest.current) return;
      if (response.status === 401 || response.status === 403) {
        replacePage('/admin');
        return;
      }
      if (response.status === 404) {
        setState('gone');
        return;
      }
      if (!response.ok) throw new Error('load');
      const next = (await response.json()) as ProblemDetail;
      if (mine !== latest.current) return;
      setProblem(next);
      setState('ready');
    } catch {
      if (mine === latest.current) setState('failed');
    }
  }, [id, replacePage]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async (to: ReportState) => {
    if (moving) return;
    setMoving(true);
    setMoveFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/brick-reports/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: to }),
      });
      if (!response.ok) throw new Error('move');
      await load();
    } catch {
      setMoveFailed(true);
    } finally {
      setMoving(false);
    }
  };

  if (state === 'failed') return <LoadError label="this report" retry={() => void load()} />;
  if (state === 'gone') return <EmptyCard kind="bot" title="This report isn’t here." text="Its notes were taken back." href="/admin/brick-reports" action="All reports" />;
  if (state === 'loading' || !problem) return <LoadingRows label="this report" rows={3} />;

  const shown = problem.sample.length;
  return (
    <div className="grid min-w-0 gap-1" data-testid="brick-report-page">
      <div className={styles.meta}>
        <span className={styles.chip} data-tone={problem.level === 'high' ? 'high' : undefined}>
          {LEVEL_WORDS[problem.level]}
        </span>
        <span className={styles.chip}>{KIND_WORDS[problem.kind]}</span>
        <span className={styles.chip}>{AREA_WORDS[problem.area]}</span>
        <span className={styles.chip} data-tone={problem.state === 'fixed' ? 'fixed' : undefined} data-testid="brick-report-state">
          {STATE_WORDS[problem.state]}
        </span>
        {problem.cameBack && (
          <span className={styles.chip} data-tone="back">
            Came back
          </span>
        )}
      </div>
      <h1 className={styles.title}>{problem.title}</h1>
      <div className={styles.stats}>
        <div>
          <b>{problem.bricks.toLocaleString()}</b>
          <span>{problem.bricks === 1 ? 'Brick' : 'Bricks'}</span>
        </div>
        <div>
          <b>{problem.people.toLocaleString()}</b>
          <span>{problem.people === 1 ? 'person' : 'people'}</span>
        </div>
        <div>
          <b>{problem.times.toLocaleString()}</b>
          <span>{problem.times === 1 ? 'time' : 'times'}</span>
        </div>
        <div>
          <b>{dayWords(problem.firstSeenAt)}</b>
          <span>first</span>
        </div>
      </div>
      <section className={styles.block} aria-labelledby="brick-report-why">
        <div id="brick-report-why" className={styles.eyebrow}>
          Why it’s {LEVEL_WORDS[problem.level].toLowerCase()}
        </div>
        <div className={styles.why} data-testid="brick-report-why">
          {problem.reasons.map((reason) => (
            <React.Fragment key={reason.label}>
              <span>{reason.label}</span>
              <i>+{reason.points}</i>
            </React.Fragment>
          ))}
        </div>
      </section>
      {shown > 0 && (
        <section className={styles.block} aria-labelledby="brick-report-say">
          <div id="brick-report-say" className={styles.eyebrow}>
            What Bricks say
          </div>
          {problem.sample.map((note, index) => (
            <p key={index} className={styles.quote} data-testid="brick-report-sample">
              {[note.tried, note.stopped, note.idea && `Idea: ${note.idea}`].filter(Boolean).join(' ')}
            </p>
          ))}
          <span className={styles.note}>
            {shown} of {problem.times.toLocaleString()} {problem.times === 1 ? 'note' : 'notes'}, picked at random
          </span>
        </section>
      )}
      <section className={styles.block} aria-label="Move it">
        <div className={styles.btns}>
          {MOVES[problem.state].map((to, index) => (
            <Button key={to} type="button" variant={index === 0 ? 'default' : 'outline'} className="h-11" disabled={moving} onClick={() => void move(to)} data-testid={`brick-report-move-${to}`}>
              {MOVE_WORDS[to]}
            </Button>
          ))}
        </div>
        {moveFailed && (
          <p className={styles.note} role="alert">
            That didn’t save. Try again.
          </p>
        )}
      </section>
    </div>
  );
}
