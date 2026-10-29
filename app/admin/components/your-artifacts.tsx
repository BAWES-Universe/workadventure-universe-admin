'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppWindow, History, Link2 } from 'lucide-react';
import { authenticatedFetch } from '@/lib/client-auth';
import { openArtifactInGame, useGameCapability } from './orbit-bridge';
import styles from './passport.module.css';
import dsStyles from './ds/ds.module.css';

/**
 * Your artifacts (game #1474): every artifact you own, from all your chats with bots, newest first. On You the newest
 * few with View all; on its own page all of them, a page at a time as you scroll. A tap opens it in the game's window.
 */

export interface OwnedArtifact {
  id: string;
  title: string;
  kind: string;
  makerName: string;
  version: number;
  openScope: string;
  updatedAt: string;
}

interface Page {
  artifacts: OwnedArtifact[];
  total: number;
  next: number | null;
}

/** The type tile of the game's chat card: the same word and colour, so a row looks like the card it came from. */
const BADGE: Record<string, [string, string]> = {
  app: ['APP', '#7c3aed'],
  page: ['PAGE', '#2563eb'],
  markdown: ['DOC', '#0f766e'],
  svg: ['SVG', '#be185d'],
};

/** What to ask a bot for, a different one each visit, so people see the range (everyday things, not only work). */
export const ARTIFACT_EXAMPLES = [
  "Make me a page that sums up what we've talked about",
  'Build me a simple calculator',
  'Make me a short presentation about the solar system',
  'Make me a packing list for a weekend trip',
  'Draw me a simple logo for my project',
] as const;

// One pick per visit; the server's page shows the first, so both agree until the browser takes over
const pickedExample = Math.floor(Math.random() * ARTIFACT_EXAMPLES.length);
const noChanges = () => () => {};

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const daysBetween = (date: Date, now: Date) => Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

/** When it last changed: the time today, Yesterday, the weekday this week, else the date. */
export function changedLabel(date: Date, now = new Date()): string {
  const days = daysBetween(date, now);
  if (days === 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' });
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** The heading a row sits under on the page, the same as the game's Media, links and files. */
export function sectionLabel(date: Date, now = new Date()): string {
  const days = daysBetween(date, now);
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) return 'Earlier this month';
  return date.toLocaleDateString('en-US', { month: 'long', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

async function loadPage(offset: number): Promise<Page> {
  const response = await authenticatedFetch(`/api/me/artifacts${offset ? `?offset=${offset}` : ''}`);
  if (!response.ok) throw new Error(`Artifacts answered ${response.status}`);
  const data = (await response.json()) as Partial<Page>;
  return {
    artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
    total: typeof data.total === 'number' ? data.total : 0,
    next: typeof data.next === 'number' ? data.next : null,
  };
}

function Row({ artifact, inGame }: { artifact: OwnedArtifact; inGame: boolean }) {
  const [label, colour] = BADGE[artifact.kind] ?? ['APP', '#5b6b82'];
  const body = (
    <>
      <span className={styles.artifactTile} style={{ background: colour }} aria-hidden="true">
        {label}
      </span>
      <span className={styles.artifactText}>
        <b>{artifact.title}</b>
        <span>
          By {artifact.makerName} · Version {artifact.version} · {changedLabel(new Date(artifact.updatedAt))}
        </span>
      </span>
    </>
  );
  // In the game it opens in the game's window. In a browser tab, one shared by link opens its page there; the others
  // open only in the game, so the row is just a line.
  if (inGame) {
    return (
      <li>
        <button type="button" className={styles.artifactRow} onClick={() => openArtifactInGame(artifact)} data-testid="my-artifact">
          {body}
        </button>
      </li>
    );
  }
  if (artifact.openScope === 'link') {
    return (
      <li>
        <a href={`/a/${artifact.id}`} target="_blank" rel="noopener" className={styles.artifactRow} data-testid="my-artifact">
          {body}
        </a>
      </li>
    );
  }
  return (
    <li>
      <div className={styles.artifactRow} data-testid="my-artifact">
        {body}
      </div>
    </li>
  );
}

/** Nothing yet: what an artifact is (a card like the chat's), what you can do with one, and what to ask a bot for. */
function NoArtifactsYet() {
  const example = ARTIFACT_EXAMPLES[useSyncExternalStore(noChanges, () => pickedExample, () => 0)];
  return (
    <div className={styles.artifactEmpty} data-testid="no-artifacts">
      <div className={styles.artifactEmptyIntro}>
        <strong>Pages and mini apps your bots make you</strong>
        <span>
          Ask any bot in a chat for a page, a mini app, a doc or a drawing. It arrives in the chat as a card like this one, and
          every one you get is kept here.
        </span>
      </div>
      <div className={styles.artifactSample} aria-hidden="true">
        <span className={styles.artifactTile} style={{ background: BADGE.app[1] }}>
          {BADGE.app[0]}
        </span>
        <span className={styles.artifactText}>
          <b>Tip calculator</b>
          <span>Mini app · Version 1 · Tap to open</span>
        </span>
      </div>
      <ul className={styles.artifactCan}>
        <li>
          <AppWindow size={18} aria-hidden="true" />
          Open it any time in the game window.
        </li>
        <li>
          <History size={18} aria-hidden="true" />
          Ask the bot to change it. Every version is kept.
        </li>
        <li>
          <Link2 size={18} aria-hidden="true" />
          Share it with a link.
        </li>
      </ul>
      <div className={styles.artifactTry}>
        <span>Try asking a bot</span>
        <q data-testid="artifact-example">{example}</q>
      </div>
    </div>
  );
}

/** Your artifacts on You: the newest few and View all, or what artifacts are when there are none yet. */
export function ArtifactsSection({ limit }: { limit: number }) {
  const inGame = useGameCapability('open-artifact');
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadPage(0)
      .then((first) => {
        if (!cancelled) setPage(first);
      })
      .catch(() => {
        // Your artifacts stay out of You when they can't be read; the page says so
        if (!cancelled) setPage(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!page) return null;
  return (
    <section className={styles.section} aria-labelledby="artifacts-heading" data-testid="your-artifacts">
      <div className={styles.head}>
        <div className={styles.headRow}>
          <h2 id="artifacts-heading" className="orbit-display">
            Your artifacts
          </h2>
          {page.total > limit && (
            <Link href="/admin/you/artifacts" className={`orbit-press ${dsStyles.sectionAction}`} data-testid="artifacts-all">
              View all
            </Link>
          )}
        </div>
      </div>
      {page.artifacts.length === 0 ? (
        <NoArtifactsYet />
      ) : (
        <div className={styles.card} style={{ paddingTop: 6, paddingBottom: 6, paddingInline: 8 }}>
          <ul className={styles.artifactList}>
            {page.artifacts.slice(0, limit).map((artifact) => (
              <Row key={artifact.id} artifact={artifact} inGame={inGame} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Every artifact you own, under week and month headings, the next ones loading as you reach the end. */
export function AllArtifacts() {
  const inGame = useGameCapability('open-artifact');
  const [artifacts, setArtifacts] = useState<OwnedArtifact[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const load = useCallback((offset: number) => {
    if (loading.current) return;
    loading.current = true;
    loadPage(offset)
      .then((page) => {
        setFailed(false);
        // A row that moved up between pages (changed meanwhile) shows once
        setArtifacts((shown) => {
          const before = offset === 0 ? [] : shown ?? [];
          const seen = new Set(before.map((artifact) => artifact.id));
          return [...before, ...page.artifacts.filter((artifact) => !seen.has(artifact.id))];
        });
        setNext(page.next);
      })
      .catch(() => setFailed(true))
      .finally(() => {
        loading.current = false;
      });
  }, []);

  useEffect(() => load(0), [load]);

  useEffect(() => {
    const target = sentinel.current;
    if (next === null || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load(next);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [next, load]);

  if (failed && !artifacts) {
    return (
      <p className={styles.empty}>
        Your artifacts could not be loaded.{' '}
        <button type="button" className={dsStyles.sectionAction} onClick={() => load(0)}>
          Try again
        </button>
      </p>
    );
  }
  if (!artifacts) return null;
  if (artifacts.length === 0) return <NoArtifactsYet />;
  const now = new Date();
  const sections = artifacts.reduce<{ label: string; items: OwnedArtifact[] }[]>((all, artifact) => {
    const label = sectionLabel(new Date(artifact.updatedAt), now);
    const same = all.find((one) => one.label === label);
    if (same) same.items.push(artifact);
    else all.push({ label, items: [artifact] });
    return all;
  }, []);
  return (
    <section className={styles.section} aria-label="Your artifacts" data-testid="your-artifacts">
      {sections.map((section) => (
        <div key={section.label} className={styles.artifactGroup}>
          <h3 className={styles.artifactHeading}>{section.label}</h3>
          <div className={styles.card} style={{ paddingTop: 6, paddingBottom: 6, paddingInline: 8 }}>
            <ul className={styles.artifactList}>
              {section.items.map((artifact) => (
                <Row key={artifact.id} artifact={artifact} inGame={inGame} />
              ))}
            </ul>
          </div>
        </div>
      ))}
      {next !== null && (
        <div ref={sentinel} className={styles.artifactMore}>
          <button type="button" className={`orbit-press ${dsStyles.sectionAction}`} onClick={() => load(next)} data-testid="artifacts-more">
            {failed ? 'Try again' : 'Show more'}
          </button>
        </div>
      )}
    </section>
  );
}
