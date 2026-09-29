'use client';

import Link from 'next/link';
import { ArrowUpRight, Lock } from 'lucide-react';
import { questCopy } from '@/lib/quests/copy';
import { ChapterProgress, QuestListRow, questHref, questWords, useChapter } from './chapter';
import { QuestStamp } from './quest-stamp';
import styles from './quests.module.css';

/**
 * Your quests on You, right under your profile: the chapter's progress and what you're on now, one tap from each
 * quest's page. The full log (not started, done) is on the Quests page.
 */
export function YouQuests() {
  const { quests, done, total } = useChapter();
  const open = quests.filter((quest) => quest.status === 'tracked' || quest.status === 'accepted');
  return (
    <section className={styles.youCard} aria-labelledby="you-quests-heading" data-testid="you-quests">
      <div className={styles.youCardHead}>
        <h2 id="you-quests-heading" className="orbit-display">
          {questCopy('quests')}
        </h2>
        <Link href="/admin/you/quests" className={styles.youCardLink}>
          All quests
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
      <ChapterProgress done={done} total={total} />
      {open.length > 0 ? (
        <div className={styles.questList}>
          {open.map((quest) => (
            <QuestListRow key={quest.id} quest={quest} />
          ))}
        </div>
      ) : (
        <p className={styles.youCardNote} data-testid="you-quests-note">
          {done === total
            ? 'You’ve finished every quest here. More are coming.'
            : 'Nothing in progress. In the game, a host with a “!” above them has a quest for you.'}
        </p>
      )}
    </section>
  );
}

/**
 * The badges you've earned, each with the quest that earned it, and a way to the rest. Private: nobody else sees them
 * (featuring one on your profile comes later, as the plan says).
 */
export function YouBadges() {
  const { quests, total } = useChapter();
  const earned = quests.filter((quest) => quest.status === 'done');
  const left = total - earned.length;
  return (
    <section className={styles.youCard} aria-labelledby="you-badges-heading" data-testid="you-badges">
      <div className={styles.youCardHead}>
        <h2 id="you-badges-heading" className="orbit-display">
          Badges
          {earned.length > 0 && <span className={styles.youCardCount}>{earned.length}</span>}
        </h2>
        <span className={styles.privateNote}>
          <Lock size={12} aria-hidden="true" />
          Only you can see these
        </span>
      </div>
      {earned.length > 0 ? (
        <ul className={styles.badgeGrid}>
          {earned.map((quest) => {
            const words = questWords(quest);
            return (
              <li key={quest.id}>
                <Link href={questHref(quest)} className={styles.badgeTile} data-testid={`badge-${quest.stamp}`}>
                  <span className={styles.badgeArt} data-earned>
                    <QuestStamp path={quest.path} size="md" />
                  </span>
                  <span className={styles.badgeText}>
                    <strong>{words.badge}</strong>
                    <span>
                      For <em dir="auto">{words.title}</em>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.youCardNote} data-testid="you-badges-empty">
          No badges yet. Every quest you finish earns one.
        </p>
      )}
      {left > 0 && (
        <Link href="/admin/you/quests" className={styles.youCardLink} data-testid="you-badges-more">
          {left === 1 ? '1 more to earn' : `${left} more to earn`}: see the quests
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}
