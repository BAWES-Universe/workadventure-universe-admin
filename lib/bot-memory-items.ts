import { createHash } from 'node:crypto';

/**
 * What a bot remembers about a person, one thing at a time (game #2003).
 *
 * The bot server saves each person's memory as one piece of JSON (`bots_memory.memories`): their name, birthday, likes
 * and facts, the events of the relationship, and the last messages. This reads that JSON as a list of things the person
 * can look at and forget, and takes a thing out of it again together with what was built from it.
 *
 * Rules the rest of the code relies on:
 *
 * - A thing is known by a key made from what it says (a hash, never the text). Forgetting keeps only that key, so the
 *   forgotten words are not kept anywhere. The bot server makes the same key (`bots/memory/MemoryItems.ts` in the game),
 *   and both sides test the same vectors.
 * - A thing that was forgotten stays gone: every save and every read of the memory takes it out again, so a copy the bot
 *   server still held, an old row that is restored, or the same words found again in older history can never bring it back.
 *   Only something the person says again after they forgot it (it carries when it was said) is learned again.
 * - What was built from a thing goes with it: the events written for it, the facts that only mean something next to it,
 *   its place in the "where was it said" list, and the lines of the chat it was drawn from.
 */

export const MEMORY_ITEM_KINDS = ['name', 'birthday', 'pref', 'fact'] as const;
export type MemoryItemKind = (typeof MEMORY_ITEM_KINDS)[number];

/** One thing the bot remembers, as the person's list shows it. Words are the game's to say, in the person's language. */
export interface MemoryItem {
  /** Its key. This is what Forget names. */
  id: string;
  kind: MemoryItemKind;
  /** The value: a name, a date, what they like, a fact's value. */
  value: string;
  /** For a fact: what it is about ("current_state"). */
  label: string | null;
  /** When it was said, in milliseconds; null when the bot did not keep it (everything from before this was kept). */
  at: number | null;
  /** Said where nobody else was, or where nothing was kept about who was there: a reply others read never uses it. */
  private: boolean;
}

/** A Forget kept: the key and when it was pressed. Never the words. */
export interface ForgottenKey {
  itemKey: string;
  createdAt: Date;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

/** Facts the bot keeps for itself, not about the person: they are never listed, and go with what they belong to. */
function isInternalFact(key: string): boolean {
  return key === 'birthday_today' || key === 'birthday_mentioned_at' || key.endsWith('_mentioned_at');
}

/** How the key of a thing is made. The same text on the bot server: change both together. */
export function memoryItemKey(kind: MemoryItemKind, label: string | null, value: string): string {
  const canonical = kind === 'fact' ? `${label ?? ''}|${value}` : value;
  return createHash('sha256').update(`${kind}|${canonical.trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

/** Said where nobody else was, or never stamped: private. Same rule as the bot server's `mayUse` (`bots/memory/Heard.ts`). */
export function isPrivateHeard(heard: unknown): boolean {
  if (!isObject(heard)) return true;
  if (heard.place === 'open') return false;
  return !(heard.place === 'nearby' && Array.isArray(heard.with) && heard.with.length > 0);
}

function factsOf(personalInfo: Json): [string, string][] {
  const facts = personalInfo.facts;
  if (!Array.isArray(facts)) return [];
  return facts.flatMap((entry): [string, string][] =>
    Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] !== undefined && entry[1] !== null ? [[entry[0], String(entry[1])]] : [],
  );
}

function numberOr(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
}

function placeOf(map: unknown, key: string): unknown {
  return isObject(map) ? map[key] : undefined;
}

/** The things in one person's saved memory, newest first where a date is known. */
export function memoryItemsOf(memoryData: unknown): MemoryItem[] {
  if (!isObject(memoryData) || !isObject(memoryData.personalInfo)) return [];
  const info = memoryData.personalInfo;
  const facts = factsOf(info);
  const factValue = (key: string) => facts.find(([name]) => name === key)?.[1];
  const events = isObject(memoryData.relationship) && Array.isArray(memoryData.relationship.importantEvents) ? memoryData.relationship.importantEvents : [];
  const drawnFrom = (key: string) => numberOr(placeOf(info.drawnFrom, key));
  const items: MemoryItem[] = [];

  if (typeof info.name === 'string' && info.name.trim()) {
    items.push({ id: memoryItemKey('name', null, info.name), kind: 'name', value: info.name, label: null, at: drawnFrom('name'), private: isPrivateHeard(placeOf(info.heard, 'name')) });
  }
  if (typeof info.birthday === 'string' && info.birthday.trim()) {
    const birthdayEvent = events.find((event) => isObject(event) && typeof event.event === 'string' && event.event.startsWith('birthday'));
    const at = drawnFrom('birthday') ?? numberOr(factValue('birthday_mentioned_at')) ?? (isObject(birthdayEvent) ? numberOr(birthdayEvent.timestamp) : null);
    items.push({ id: memoryItemKey('birthday', null, info.birthday), kind: 'birthday', value: info.birthday, label: null, at, private: isPrivateHeard(placeOf(info.heard, 'birthday')) });
  }
  if (Array.isArray(info.preferences)) {
    for (const preference of info.preferences) {
      if (typeof preference !== 'string' || !preference.trim()) continue;
      const key = `pref:${preference}`;
      items.push({ id: memoryItemKey('pref', null, preference), kind: 'pref', value: preference, label: null, at: drawnFrom(key), private: isPrivateHeard(placeOf(info.heard, key)) });
    }
  }
  for (const [name, value] of facts) {
    if (isInternalFact(name) || !value.trim()) continue;
    const key = `fact:${name}`;
    // "I'm tired" is kept as current_state: tired, with when it was said next to it
    const at = drawnFrom(key) ?? (name === 'current_state' ? numberOr(factValue(`${value}_mentioned_at`)) : null);
    items.push({ id: memoryItemKey('fact', name, value), kind: 'fact', value, label: name, at, private: isPrivateHeard(placeOf(info.heard, key)) });
  }

  // Newest first; the ones with no date keep their order, after the dated ones
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.at ?? -1) - (a.item.at ?? -1) || a.index - b.index)
    .map(({ item }) => item);
}

/** The shortest a phrase may be for lines of the chat to be taken out by the words they hold, when no line was noted. */
const MIN_PHRASE = 4;

/**
 * Finds the words of a thing in a line: a letter or digit at an edge of the words must not touch another one, so "Rome" is not found inside "Chrome"
 * (an edge that is a symbol or a space has nothing to touch). Words are matched as written, in any case (both are lower case when this is used).
 */
function wordsIn(words: string): RegExp {
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^[\p{L}\p{N}]/u.test(words) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = /[\p{L}\p{N}]$/u.test(words) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${before}${escaped}${after}`, 'u');
}

/** A like kept as "pizza (favorite food)" is "pizza" in the chat: nobody types the rest. Same as the game's `plainThing`. */
export function plainThing(value: string): string {
  return value.replace(/\s*\((?:favou?rite)[^)]*\)\s*$/iu, '').trim();
}

const TASTE_WORDS = "likes?|loves?|loved|enjoys?|enjoyed|prefers?|preferred|adores?|hates?|hated|dislikes?|disliked|despises?|detests?|loathes?|favou?rite|can['’]?t stand|cannot stand|fan of|into|go-to";
const NOT_PART_OF_A_WORD = '(?<![\\p{L}\\p{N}])';
const END_OF_A_WORD = '(?![\\p{L}\\p{N}])';

/**
 * How lines say a short value (under four letters, "tea") as a taste, since it is too short to be taken out of every line by its
 * letters: what the person says ("I like tea", "my favorite drink is tea") and what the bot says back ("You love tea", "Tea is your
 * favorite"). Both are lower case here. Same idea as the game's `dropItems` for short likes and dislikes.
 */
function tasteLinesOf(value: string): { person: RegExp; bot: RegExp; word: RegExp } {
  const word = wordsIn(value).source;
  const person = `${NOT_PART_OF_A_WORD}(?:i|my)${END_OF_A_WORD}[^.!?\\n]{0,40}?${NOT_PART_OF_A_WORD}(?:${TASTE_WORDS})${END_OF_A_WORD}[^.!?\\n]{0,30}?${word}`;
  const you = `${NOT_PART_OF_A_WORD}(?:you|your|you['’]re|you['’]ve)${END_OF_A_WORD}`;
  const taste = `${NOT_PART_OF_A_WORD}(?:${TASTE_WORDS})${END_OF_A_WORD}`;
  const bot = `${you}[^.!?\\n]{0,40}?${taste}[^.!?\\n]{0,25}?${word}|${word}[^.!?\\n]{0,40}?${you}[^.!?\\n]{0,40}?${taste}`;
  return { person: new RegExp(person, 'u'), bot: new RegExp(bot, 'u'), word: wordsIn(value) };
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function drop(map: unknown, key: string): void {
  if (isObject(map)) delete map[key];
}

/**
 * The same memory without these things and without what was built from them. Never changes what it is given.
 *
 * `onlyOlderThan` keeps a thing the person said again after they forgot it: a thing carrying the moment it was said
 * (`drawnFrom`) that is later than the Forget is theirs to have again, so it stays. Without it every match goes.
 */
export function withoutItems(memoryData: unknown, keys: ReadonlySet<string>, onlyOlderThan?: ReadonlyMap<string, Date>): { data: unknown; removed: number } {
  if (keys.size === 0 || !isObject(memoryData) || !isObject(memoryData.personalInfo)) return { data: memoryData, removed: 0 };
  const data = copy(memoryData) as Json;
  const info = data.personalInfo as Json;
  const history = Array.isArray(data.conversationHistory) ? (data.conversationHistory as unknown[]) : null;
  const events = isObject(data.relationship) && Array.isArray(data.relationship.importantEvents) ? (data.relationship.importantEvents as unknown[]) : null;
  const doomedLines = new Set<unknown>();
  const phrases: { text: RegExp; anySender: boolean; forgotAt: number | null }[] = [];
  // Short likes and dislikes ("tea"): found by what is said about them, not by the bare letters
  const shortTastes: { person: RegExp; bot: RegExp; word: RegExp; drawn: number | null; forgotAt: number | null }[] = [];
  let removed = 0;

  const goes = (id: string, drawn: number | null) => {
    if (!keys.has(id)) return false;
    const forgotAt = onlyOlderThan?.get(id);
    return !(forgotAt && drawn !== null && drawn > forgotAt.getTime());
  };
  const takeLines = (drawn: number | null, phrase: string, id: string, taste = false) => {
    if (!history) return;
    if (drawn !== null) {
      for (const line of history) if (isObject(line) && line.timestamp === drawn && line.sender === 'person') doomedLines.add(line);
    }
    // The bot's own lines that say it back go too. When no line was noted for it (what the bot kept before this), the
    // person's lines that hold its words go as well.
    // A line said after the Forget is the person's again, so the phrase only takes out the lines from before it
    if (phrase.trim().length >= MIN_PHRASE) phrases.push({ text: wordsIn(phrase.trim().toLowerCase()), anySender: drawn === null, forgotAt: onlyOlderThan?.get(id)?.getTime() ?? null });
    else if (taste && phrase.trim().length > 0) shortTastes.push({ ...tasteLinesOf(phrase.trim().toLowerCase()), drawn, forgotAt: onlyOlderThan?.get(id)?.getTime() ?? null });
  };
  const dropEventsOf = (prefix: string) => {
    if (!events) return;
    (data.relationship as Json).importantEvents = events.filter((event) => !(isObject(event) && typeof event.event === 'string' && event.event.startsWith(prefix)));
  };

  if (typeof info.name === 'string') {
    const drawn = numberOr(placeOf(info.drawnFrom, 'name'));
    if (goes(memoryItemKey('name', null, info.name), drawn)) {
      takeLines(drawn, info.name, memoryItemKey('name', null, info.name));
      delete info.name;
      drop(info.heard, 'name');
      drop(info.drawnFrom, 'name');
      removed++;
    }
  }
  if (typeof info.birthday === 'string') {
    const drawn = numberOr(placeOf(info.drawnFrom, 'birthday'));
    if (goes(memoryItemKey('birthday', null, info.birthday), drawn)) {
      takeLines(drawn, info.birthday, memoryItemKey('birthday', null, info.birthday));
      delete info.birthday;
      drop(info.heard, 'birthday');
      drop(info.drawnFrom, 'birthday');
      // What was written for it: the events, and the facts that only say it was mentioned
      dropEventsOf('birthday');
      info.facts = factsOf(info).filter(([name]) => name !== 'birthday_today' && name !== 'birthday_mentioned_at');
      removed++;
    }
  }
  if (Array.isArray(info.preferences)) {
    info.preferences = (info.preferences as unknown[]).filter((preference) => {
      if (typeof preference !== 'string') return true;
      const key = `pref:${preference}`;
      const drawn = numberOr(placeOf(info.drawnFrom, key));
      if (!goes(memoryItemKey('pref', null, preference), drawn)) return true;
      // A favorite is kept as "pizza (favorite food)", and what is said in the chat is "pizza"
      takeLines(drawn, plainThing(preference), memoryItemKey('pref', null, preference), true);
      drop(info.heard, key);
      drop(info.drawnFrom, key);
      removed++;
      return false;
    });
  }
  if (Array.isArray(info.facts)) {
    const kept: [string, string][] = [];
    // The fact that says when "tired" was said goes with it
    const alsoGoes = new Set<string>();
    for (const [name, value] of factsOf(info)) {
      const key = `fact:${name}`;
      const drawn = numberOr(placeOf(info.drawnFrom, key));
      if (isInternalFact(name) || !goes(memoryItemKey('fact', name, value), drawn)) {
        kept.push([name, value]);
        continue;
      }
      // The words of a fact go from the chat too (when no line was noted for it): "I work at Acme" is not left there to bring it back
      takeLines(drawn, value, memoryItemKey('fact', name, value), name.startsWith('dislike_'));
      drop(info.heard, key);
      drop(info.drawnFrom, key);
      if (name === 'current_state') alsoGoes.add(`${value}_mentioned_at`);
      removed++;
    }
    info.facts = kept.filter(([name]) => !alsoGoes.has(name));
  }

  if (history && (doomedLines.size > 0 || phrases.length > 0 || shortTastes.length > 0)) {
    data.conversationHistory = history.filter((line, index) => {
      if (doomedLines.has(line)) return false;
      const text = isObject(line) && typeof line.message === 'string' ? line.message.toLowerCase() : '';
      const fromBot = isObject(line) && line.sender === 'bot';
      const said = isObject(line) && typeof line.timestamp === 'number' ? line.timestamp : null;
      const before = (at: number | null) => !(at !== null && said !== null && said > at);
      if (phrases.some((phrase) => (phrase.anySender || fromBot) && phrase.text.test(text) && before(phrase.forgotAt))) return false;
      const earlier = index > 0 ? history[index - 1] : null;
      return !shortTastes.some((taste) => {
        if (!before(taste.forgotAt)) return false;
        if (!fromBot) return taste.person.test(text);
        // What the bot says back, and its reply right after the line the thing came from when it says the word ("Tea it is!")
        return taste.bot.test(text) || (earlier !== null && doomedLines.has(earlier) && taste.word.test(text));
      });
    });
  }
  return { data, removed };
}

/**
 * The same memory with everything the person forgot taken out. A thing is out when its key was forgotten and it was not
 * said again after: so a stale copy, a restored row or older history never brings it back.
 */
export function withoutForgotten(memoryData: unknown, forgotten: readonly ForgottenKey[]): unknown {
  if (forgotten.length === 0) return memoryData;
  const keys = new Set(forgotten.map((forget) => forget.itemKey));
  const forgotAt = new Map<string, Date>();
  for (const forget of forgotten) {
    const before = forgotAt.get(forget.itemKey);
    if (!before || before < forget.createdAt) forgotAt.set(forget.itemKey, forget.createdAt);
  }
  return withoutItems(memoryData, keys, forgotAt).data;
}
