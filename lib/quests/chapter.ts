import type { OrbitQuestEntry } from '@/lib/orbit-bridge';
import { QUEST_MINUTES, type QuestPath, type QuestStampId } from './model';

/**
 * The Welcome chapter as the player lives it, for Orbit's quest pages: every quest of the chapter, merged with what
 * the game last sent over the bridge (`orbit-quest-state`). A quest the game hasn't mentioned hasn't been started.
 * Orbit keeps nothing of its own; the game is the record until the quest engine (part 3A).
 */
export type ChapterQuestStatus = 'tracked' | 'accepted' | 'done' | 'not-started';

export interface ChapterQuest {
  /** The game's fixed key, also the page's address: "welcome.meet". */
  id: string;
  path: QuestPath;
  /** The badge it earns. */
  stamp: QuestStampId;
  status: ChapterQuestStatus;
  /** The game's title, when it sent one. */
  title?: string;
  giver?: string;
  room?: string;
  /** "Find the Courtyard", when the game sent it. */
  objective?: string;
  minutes: number;
}

export const WELCOME_CHAPTER: readonly {
  id: string;
  path: QuestPath;
  stamp: QuestStampId;
}[] = [
  { id: 'welcome.meet', path: 'meet', stamp: 'first-hello' },
  { id: 'welcome.explore', path: 'explore', stamp: 'explorer' },
  { id: 'welcome.build', path: 'build', stamp: 'builder' },
];

export function chapterQuests(entries: readonly OrbitQuestEntry[]): ChapterQuest[] {
  return WELCOME_CHAPTER.map(({ id, path, stamp }) => {
    const entry = entries.find((candidate) => candidate.id === id);
    return {
      id,
      path,
      stamp,
      status: entry?.status ?? 'not-started',
      ...(entry?.title ? { title: entry.title } : {}),
      ...(entry?.giver ? { giver: entry.giver } : {}),
      ...(entry ? { room: entry.room } : {}),
      ...(entry?.objective ? { objective: entry.objective } : {}),
      minutes: QUEST_MINUTES[path],
    };
  });
}

/** In progress first (the one on the map leading), then not started, then done: the order of the game's log. */
export const CHAPTER_ORDER: Record<ChapterQuestStatus, number> = {
  tracked: 0,
  accepted: 1,
  'not-started': 2,
  done: 3,
};
