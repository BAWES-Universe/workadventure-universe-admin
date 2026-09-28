'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { Check, ChevronRight, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHAPTER_ORDER, chapterQuests, type ChapterQuest } from '@/lib/quests/chapter';
import { QUEST_PATH_COPY, isolateName, questCopy } from '@/lib/quests/copy';
import { getQuestLog, getServerQuestLog, subscribeQuestLog } from '@/lib/quests/quest-log';
import { QuestStamp } from './quest-stamp';
import styles from './quests.module.css';

/** The Welcome chapter, live from the game: every quest with its status, and how many are done. */
export function useChapter() {
  const log = useSyncExternalStore(subscribeQuestLog, getQuestLog, getServerQuestLog);
  const quests = chapterQuests(log ?? []).sort((a, b) => CHAPTER_ORDER[a.status] - CHAPTER_ORDER[b.status]);
  const done = quests.filter((quest) => quest.status === 'done').length;
  return { quests, done, total: quests.length, heardFromGame: log !== null };
}

export function questHref(quest: ChapterQuest): string {
  return `/admin/you/quests/${encodeURIComponent(quest.id)}`;
}

/** A quest in words: the game's own, with this player's names where the game sent them. */
export function questWords(quest: ChapterQuest) {
  const copy = QUEST_PATH_COPY[quest.path];
  const title = quest.title ?? questCopy(copy.title);
  // Explore names its place only once the game has picked one; before that, the quest says what it's about.
  const objective = quest.objective ?? (quest.path === 'explore' ? 'Find a named place in the room' : questCopy(copy.objective));
  // Explore's description is its objective with a full stop: the page shows the objective once, not twice.
  const description: string | undefined =
    quest.path === 'explore' ? (quest.objective ? undefined : 'Find a named place in the room you’re in.') : questCopy(copy.description);
  const badge = questCopy(copy.stamp);
  const origin =
    quest.room !== undefined
      ? quest.giver
        ? questCopy('log.fromHost', {
            host: isolateName(quest.giver),
            room: isolateName(quest.room),
          })
        : questCopy('log.here', { room: isolateName(quest.room) })
      : undefined;
  return {
    title,
    objective,
    description,
    badge,
    reward: questCopy('stamps.badge', { stamp: badge }),
    origin,
  };
}

/** "1 of 3 done", with one segment per quest. */
export function ChapterProgress({ done, total }: { done: number; total: number }) {
  return (
    <div className={styles.progress}>
      <span data-testid="chapter-progress">{questCopy('log.progress', { done, total })}</span>
      <span className={styles.progressBar} aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <span key={index} data-lit={index < done || undefined} />
        ))}
      </span>
    </div>
  );
}

/** Where a quest stands, in the game's words. Nothing for a quest not started: its row says so by being faded. */
export function QuestStatusChip({ status }: { status: ChapterQuest['status'] }) {
  if (status === 'tracked')
    return (
      <span className={cn(styles.chip, styles.chipMap)}>
        <MapPin size={12} aria-hidden="true" />
        {questCopy('log.onMap')}
      </span>
    );
  if (status === 'accepted') return <span className={styles.chip}>{questCopy('log.inProgress')}</span>;
  if (status === 'done')
    return (
      <span className={cn(styles.chip, styles.chipDone)}>
        <Check size={12} aria-hidden="true" />
        {questCopy('log.done')}
      </span>
    );
  return null;
}

/** One quest in a list: the badge it earns, its title and objective, where it stands. Opens its page. */
export function QuestListRow({ quest }: { quest: ChapterQuest }) {
  const words = questWords(quest);
  return (
    <Link href={questHref(quest)} className={styles.questRow} data-status={quest.status} data-testid={`quest-${quest.id}`}>
      <QuestStamp path={quest.path} size="sm" muted={quest.status !== 'done'} />
      <span className={styles.questRowText}>
        <strong dir="auto">{words.title}</strong>
        <span dir="auto">{quest.status === 'done' ? words.reward : words.objective}</span>
        {quest.status !== 'not-started' && (
          <span className={styles.questRowChip}>
            <QuestStatusChip status={quest.status} />
          </span>
        )}
      </span>
      <ChevronRight className={styles.questRowChevron} size={16} aria-hidden="true" />
    </Link>
  );
}
