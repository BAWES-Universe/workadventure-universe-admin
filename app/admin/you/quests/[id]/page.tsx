'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Check, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { questCopy } from '@/lib/quests/copy';
import { EmptyCard } from '../../../components/ds';
import { QuestStatusChip, questWords, useChapter } from '../../../components/quests/chapter';
import { QuestStamp } from '../../../components/quests/quest-stamp';
import styles from '../../../components/quests/quests.module.css';

/**
 * One quest, as its details read in the game: who gave it, what it's about, the objective as a tracker line, and the
 * badge it earns. What to do next is said in words; the game is where you act on it.
 */
export default function QuestPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params?.id ?? ''));
  const { quests } = useChapter();
  const quest = quests.find((candidate) => candidate.id === id);
  if (!quest) {
    return (
      <EmptyCard
        kind="room"
        title="There’s no such quest."
        text="It may belong to a chapter that isn’t here yet."
        href="/admin/you/quests"
        action="See your quests"
        testId="quest-missing"
      />
    );
  }
  const words = questWords(quest);
  const done = quest.status === 'done';
  const open = quest.status === 'tracked' || quest.status === 'accepted';
  return (
    <article className={styles.questPage} data-testid={`quest-page-${quest.id}`}>
      <header className={styles.questHero}>
        <span className={styles.badgeArt} data-earned={done || undefined}>
          <QuestStamp path={quest.path} size="lg" muted={!done} />
        </span>
        <div className={styles.questHeroText}>
          <h1 className="orbit-display" dir="auto">
            {words.title}
          </h1>
          {words.origin && (
            <p dir="auto">
              {words.origin} · {questCopy('minutes', { minutes: quest.minutes })}
            </p>
          )}
          <QuestStatusChip status={quest.status} />
        </div>
      </header>

      {words.description && (
        <p className={styles.questDescription} dir="auto">
          {words.description}
        </p>
      )}

      <section aria-labelledby="quest-objective" className={styles.questSection}>
        <h2 id="quest-objective">{questCopy('detail.objective')}</h2>
        <div className={cn(styles.objective, done && styles.objectiveDone)} data-testid="quest-objective">
          <span className={styles.objectiveDot} aria-hidden="true" />
          <span dir="auto">{words.objective}</span>
          {done ? (
            <Check size={16} className={styles.objectiveTick} aria-label="Done" />
          ) : open ? (
            <span className={styles.objectiveCount}>0/1</span>
          ) : null}
        </div>
        {quest.path === 'build' && !done && <p className={styles.groupNote}>{questCopy('paths.build.needs')}</p>}
        {quest.status === 'tracked' && (
          <p className={styles.onMapNote} data-testid="quest-on-map">
            <MapPin size={14} aria-hidden="true" />
            {questCopy('detail.onMapNote')}
          </p>
        )}
      </section>

      <section aria-labelledby="quest-reward" className={styles.questSection}>
        <h2 id="quest-reward">{questCopy('detail.reward')}</h2>
        <div className={styles.rewardCard} data-earned={done || undefined} data-testid="quest-reward">
          <QuestStamp path={quest.path} size="sm" muted={!done} />
          <span>
            <strong>{words.reward}</strong>
            <span>{done ? 'Earned. It’s on You, under Badges.' : 'Not earned yet'}</span>
          </span>
        </div>
      </section>

      {!done && (
        <p className={styles.nextStep} data-testid="quest-next-step">
          {quest.status === 'not-started'
            ? 'To take it, open Quests in the game (the pill at the bottom, or your profile menu) and choose Accept.'
            : quest.status === 'accepted'
              ? 'To be guided there, open Quests in the game and choose Show on map.'
              : 'Close Orbit and follow the marker on your map.'}
        </p>
      )}
      <Link href="/admin/you/quests" className={styles.youCardLink}>
        All quests
      </Link>
    </article>
  );
}
