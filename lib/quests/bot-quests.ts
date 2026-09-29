import type { QuestContextArea, QuestPath } from './model';
import { QUEST_MINUTES } from './model';
import { WELCOME_CHAPTER } from './chapter';
import { QUEST_PATH_COPY, questCopy } from './copy';

/**
 * What a quest-giver bot is told about the quests it gives (workadventure-universe#565): read by the bots service
 * with its service token and appended to the bot's system prompt. Display text only, in the game's own words and
 * source locale (the bot answers in the player's language itself): no player text, no ids beyond the quest's key.
 */
export interface BotQuest {
  /** The game's fixed key, as Orbit's quest pages use it: "welcome.meet". */
  id: string;
  title: string;
  description: string;
  objective: string;
  minutes: number;
  /** The badge it earns. */
  badge: string;
  /**
   * For Explore: the named areas the game can send a newcomer to in this room. The game picks one (the published
   * one, else the nearest), so the bot may name them but never promises which.
   */
  areas?: string[];
  /** What a player must have before this quest can be done here (Build: edit rights). */
  needs?: string;
}

export interface BotQuestList {
  botId: string;
  roomId: string;
  quests: BotQuest[];
  /**
   * Where the list came from. `welcome-chapter`: the proof slice's fixed chapter, which every bot in a room offers
   * (the game picks the host on the player's side). The quest engine (Orbit #202) replaces it with the bot's own
   * host binding, and a bot with no binding then gets an empty list.
   */
  source: 'welcome-chapter';
}

const EXPLORE_FALLBACK_AREA = 'area';

function questOf(path: QuestPath, areas: readonly QuestContextArea[]): BotQuest {
  const chapter = WELCOME_CHAPTER.find((quest) => quest.path === path)!;
  const copy = QUEST_PATH_COPY[path];
  const quest: BotQuest = {
    id: chapter.id,
    title: questCopy(copy.title),
    description: questCopy(copy.description, { area: EXPLORE_FALLBACK_AREA }),
    objective: questCopy(copy.objective, { area: EXPLORE_FALLBACK_AREA }),
    minutes: QUEST_MINUTES[path],
    badge: questCopy(copy.stamp),
  };
  if (path === 'explore') quest.areas = areas.map((area) => area.name);
  if (path === 'build') quest.needs = questCopy('paths.build.needs');
  return quest;
}

/**
 * The Welcome chapter as this room offers it, in the game's words: Meet always (people come and go), Explore only
 * when the room has a named area to find, Build always (the game hides it from people who cannot edit; the bot is
 * told what it needs).
 */
export function welcomeQuestsForRoom(areas: readonly QuestContextArea[]): BotQuest[] {
  const quests: BotQuest[] = [questOf('meet', areas)];
  if (areas.length > 0) quests.push(questOf('explore', areas));
  quests.push(questOf('build', areas));
  return quests;
}
