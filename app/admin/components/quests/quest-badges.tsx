'use client';

import { useSyncExternalStore } from 'react';
import { isolateName, questCopy, type QuestCopyKey } from '@/lib/quests/copy';
import { QUEST_STAMP_PATH, type QuestStampId } from '@/lib/quests/model';
import { getQuestLog, getServerQuestLog, subscribeQuestLog } from '@/lib/quests/quest-log';
import { QuestStamp } from './quest-stamp';
import styles from './quests.module.css';

/** The Welcome chapter's badges, in the order its quests are listed in the game. */
const BADGES: { id: QuestStampId; name: QuestCopyKey }[] = [
  { id: 'first-hello', name: 'stamps.meet' },
  { id: 'explorer', name: 'stamps.explore' },
  { id: 'builder', name: 'stamps.build' },
];

/**
 * Your badges and the quests you're on, right under your profile on You: every badge of the chapter (earned ones in
 * colour, the rest faded so you can see what's left), then what you're doing now. In the game's words, from what the
 * game last sent over the bridge (`orbit-quest-state`); Orbit keeps nothing of its own.
 */
export function QuestBadges() {
  const entries = useSyncExternalStore(subscribeQuestLog, getQuestLog, getServerQuestLog) ?? [];
  const earned = new Set(entries.flatMap((entry) => (entry.status === 'done' && entry.stamp ? [entry.stamp] : [])));
  const open = entries.filter((entry) => entry.status !== 'done');

  return (
    <section className={styles.badges} aria-labelledby="quest-badges-heading" data-testid="quest-badges">
      <div className={styles.badgesHead}>
        <h2 id="quest-badges-heading" className="orbit-display">
          {questCopy('quests')}
        </h2>
        <span data-testid="quest-badges-progress">{questCopy('log.progress', { done: earned.size, total: BADGES.length })}</span>
      </div>
      <div className={styles.badgesBody}>
        <ul className={styles.badgeRow}>
          {BADGES.map(({ id, name }) => {
            const has = earned.has(id);
            return (
              <li key={id} className={styles.badge} data-earned={has || undefined} data-testid={`badge-${id}`}>
                <QuestStamp path={QUEST_STAMP_PATH[id]} size="md" muted={!has} />
                <span>{questCopy(name)}</span>
                {!has && <span className="sr-only">(not earned yet)</span>}
              </li>
            );
          })}
        </ul>
        {open.length > 0 ? (
          <div className={styles.now}>
            <h3>{questCopy('log.inProgress')}</h3>
            <ul>
              {open.map((entry) => (
                <li key={entry.id} data-testid={`quest-${entry.id}`}>
                  <span className={styles.nowDot} data-tracked={entry.status === 'tracked' || undefined} aria-hidden="true" />
                  <span className={styles.nowText}>
                    <strong dir="auto">{entry.title}</strong>
                    <span dir="auto">
                      {entry.giver
                        ? questCopy('log.fromHost', { host: isolateName(entry.giver), room: isolateName(entry.room) })
                        : questCopy('log.here', { room: isolateName(entry.room) })}
                    </span>
                  </span>
                  {entry.status === 'tracked' && <span className={styles.onMap}>{questCopy('log.onMap')}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          earned.size < BADGES.length && (
            <p className={styles.badgesHint} data-testid="quest-badges-hint">
              {entries.length === 0
                ? 'Quests you take on in the game earn these badges.'
                : 'Take on another quest in the game to earn the rest.'}
            </p>
          )
        )}
      </div>
    </section>
  );
}
