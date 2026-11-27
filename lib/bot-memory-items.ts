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
  const composed = words.normalize('NFC');
  const escaped = composed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Scripts written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese) have no word edges: "喜欢茶" sits inside "我喜欢茶很多"
  const joined = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]';
  const first = Array.from(composed)[0] ?? '';
  const last = Array.from(composed).pop() ?? '';
  const edge = /^[\p{L}\p{N}]/u;
  const before = edge.test(first) && !new RegExp(`^${joined}$`, 'u').test(first) ? '(?<![\\p{L}\\p{N}\\p{M}])' : '';
  const after = /[\p{L}\p{N}\p{M}]$/u.test(last) && !new RegExp(`^${joined}$`, 'u').test(last) ? '(?![\\p{L}\\p{N}\\p{M}])' : '';
  return new RegExp(`${before}${escaped}${after}`, 'u');
}

/** A like kept as "pizza (favorite food)" is "pizza" in the chat: nobody types the rest. Same as the game's `plainThing`. */
export function plainThing(value: string): string {
  return value.replace(/\s*\((?:favou?rite)[^)]*\)\s*$/iu, '').trim();
}

const TASTE_WORDS = "likes?|loves?|loved|enjoys?|enjoyed|prefers?|preferred|adores?|hates?|hated|dislikes?|disliked|despises?|detests?|loathes?|avoids?|favou?rite|can['’]?t stand|cannot stand|can not stand|(?:don['’]?t|do not|doesn['’]?t|does not) (?:like|enjoy|love)|not a fan of|not into|sick of|tired of|fan of|(?<!(?:\\b(?:(?:walk|bump|step|drive|driving|mov|fall|crash|turn|look|log|sign|pour|put|stick|dive|jump|dip|burst|pop|rush|peer|peek|sneak|barg|stumbl|wander|head|slip|climb|ride|swim|fly|hop|march|stroll|enter|creep|tipt|spill|stir)\\w*|go|goes|going|gone|went|came|come|comes|coming|ran|run|runs|running|drove|rode|swam|flew|fell|stuck|dov|crept\\b)(?:\\s+(?:right|straight|back|out|up|down|over|just|all the way|headfirst))?)\\s+)into|go-to"
const NOT_PART_OF_A_WORD = '(?<![\\p{L}\\p{N}])';
const END_OF_A_WORD = '(?![\\p{L}\\p{N}])';

/**
 * How lines say a short value (under four letters, "tea") as a taste, since it is too short to be taken out of every line by its
 * letters: what the person says ("I like tea", "my favorite drink is tea") and what the bot says back ("You love tea", "Tea is your
 * favorite"). Both are lower case here. Same idea as the game's `dropItems` for short likes and dislikes.
 */
function tasteLinesOf(value: string): { person: RegExp; bot: RegExp; word: RegExp } {
  const word = wordsIn(value).source;
  const iOrMy = `${NOT_PART_OF_A_WORD}(?:i|my)${END_OF_A_WORD}`;
  const taste = `${NOT_PART_OF_A_WORD}(?:${TASTE_WORDS})${END_OF_A_WORD}`;
  // What they say of it as theirs: "I like tea", and the thing first, "Tea is my favorite drink", "Tea, I love it"
  const person = `${iOrMy}[^.!?\\n]{0,40}?${taste}[^.!?\\n]{0,30}?${word}|${word}[^.!?\\n]{0,25}?${iOrMy}[^.!?\\n]{0,25}?${taste}`;
  const you = `${NOT_PART_OF_A_WORD}(?:you|your|you['’]re|you['’]ve)${END_OF_A_WORD}`;
  const bot = `${you}[^.!?\\n]{0,40}?${taste}[^.!?\\n]{0,25}?${word}|${word}[^.!?\\n]{0,40}?${you}[^.!?\\n]{0,40}?${taste}`;
  return { person: new RegExp(person, 'u'), bot: new RegExp(bot, 'u'), word: wordsIn(value) };
}

/** How a person gives their name ("my name is ali", "call me ali", "I'm ali"); the text and the name are lower case here. */
function nameGivenAs(lowerName: string): RegExp {
  return new RegExp(`(?:my name(?:['’]s| is)|call me|(?<![\\p{L}\\p{N}])i(?:['’]m| am)(?: called| named)?)\\s+${wordsIn(lowerName).source}`, 'u');
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
  // Each thing being forgotten is an owner: a line it took remembers which thing took it, so the bot's reply after it is only
  // looked at for the words of that same thing
  let owner = 0;
  const doomedLines = new Map<unknown, Set<number>>();
  const phrases: { text: RegExp; exact: boolean; forgotAt: number | null; owner: number; person?: boolean }[] = [];
  // Short likes and dislikes ("tea"): found by what is said about them, not by the bare letters
  const shortTastes: { person: RegExp; bot: RegExp; word: RegExp; forgotAt: number | null; owner: number }[] = [];
  // Short names ("Ali"): the person's lines that give it ("my name is Ali"), and the bot's lines that say it as written
  const shortNames: { person: RegExp; bot: RegExp; exact: boolean; forgotAt: number | null; owner: number }[] = [];
  // Any other short value ("ill", "30"): only the bot's reply right after the line it came from, when it says the value back
  const shortOthers: { word: RegExp; forgotAt: number | null; owner: number }[] = [];
  let removed = 0;

  const goes = (id: string, drawn: number | null) => {
    if (!keys.has(id)) return false;
    const forgotAt = onlyOlderThan?.get(id);
    return !(forgotAt && drawn !== null && drawn > forgotAt.getTime());
  };
  const takeLines = (drawn: number | null, phrase: string, id: string, kind: 'name' | 'taste' | 'other' = 'other') => {
    if (!history) return;
    owner++;
    const mine = owner;
    if (drawn !== null) {
      for (const line of history) {
        if (isObject(line) && line.timestamp === drawn && line.sender === 'person') doomedLines.set(line, (doomedLines.get(line) ?? new Set<number>()).add(mine));
      }
    }
    // The lines that say it back go too, the bot's and the person's: only the last line it was said in is noted, and a thing
    // said twice would otherwise leave the first. A line said after the Forget is the person's again, so only lines from before it go.
    const trimmed = phrase.trim();
    const forgotAt = onlyOlderThan?.get(id)?.getTime() ?? null;
    // A name written with a capital ("Will") is found only as written, so the word it is also ("I will") stays
    // Deliberate: forgetting leans to taking too much. A capitalised name that is also a word ("Will", "Mark", "Grace") also takes
    // an unrelated line that starts with it ("Will you help me?"), from that person's own saved chat only. A line is never left that
    // says a forgotten name; the game does the same (pinned by a test).
    const exact = kind === 'name' && trimmed !== trimmed.toLowerCase();
    if (trimmed.length >= MIN_PHRASE) {
      phrases.push({ text: wordsIn(exact ? trimmed : trimmed.toLowerCase()), exact, forgotAt, owner: mine });
      // A name is also found where it is given, in any capitals ("my name is sara" for "Sara"); the bare word stays as written
      if (kind === 'name') phrases.push({ text: nameGivenAs(trimmed.toLowerCase()), exact: false, forgotAt, owner: mine, person: true });
    }
    else if (trimmed.length > 0) {
      const lower = trimmed.toLowerCase();
      if (kind === 'name') {
        shortNames.push({ person: nameGivenAs(lower), bot: wordsIn(exact ? trimmed : lower), exact, forgotAt, owner: mine });
      } else if (kind === 'taste') shortTastes.push({ ...tasteLinesOf(lower), forgotAt, owner: mine });
      else shortOthers.push({ word: wordsIn(lower), forgotAt, owner: mine });
    }
  };
  const dropEventsOf = (prefix: string) => {
    if (!events) return;
    (data.relationship as Json).importantEvents = events.filter((event) => !(isObject(event) && typeof event.event === 'string' && event.event.startsWith(prefix)));
  };

  if (typeof info.name === 'string') {
    const drawn = numberOr(placeOf(info.drawnFrom, 'name'));
    if (goes(memoryItemKey('name', null, info.name), drawn)) {
      takeLines(drawn, info.name, memoryItemKey('name', null, info.name), 'name');
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
      takeLines(drawn, plainThing(preference), memoryItemKey('pref', null, preference), 'taste');
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
      takeLines(drawn, value, memoryItemKey('fact', name, value), name.startsWith('dislike_') ? 'taste' : 'other');
      drop(info.heard, key);
      drop(info.drawnFrom, key);
      if (name === 'current_state') alsoGoes.add(`${value}_mentioned_at`);
      removed++;
    }
    info.facts = kept.filter(([name]) => !alsoGoes.has(name));
  }

  if (history && (doomedLines.size > 0 || phrases.length > 0 || shortTastes.length > 0 || shortNames.length > 0 || shortOthers.length > 0)) {
    const textOf = (line: unknown) => (isObject(line) && typeof line.message === 'string' ? line.message.normalize('NFC') : '');
    const saidAt = (line: unknown) => (isObject(line) && typeof line.timestamp === 'number' ? line.timestamp : null);
    const stillTheirs = (line: unknown, forgotAt: number | null) => {
      const said = saidAt(line);
      return forgotAt !== null && said !== null && said > forgotAt;
    };
    // The things that take a person's line: the one it came from, the ones whose words it holds, and the ones it says as a name or a taste.
    // A line said after the Forget is the person's again, so it is only taken when it was said before.
    // `again` finds the lines that say it but were said after the Forget, which are the person's own again
    const takenBy = (line: unknown, again = false): Set<number> => {
      const owners = new Set<number>();
      if (!isObject(line) || line.sender !== 'person') return owners;
      if (!again) for (const one of doomedLines.get(line) ?? []) owners.add(one);
      const text = textOf(line);
      const lower = text.toLowerCase();
      for (const phrase of phrases) if (phrase.text.test(phrase.exact ? text : lower) && stillTheirs(line, phrase.forgotAt) === again) owners.add(phrase.owner);
      for (const name of shortNames) if (name.person.test(lower) && stillTheirs(line, name.forgotAt) === again) owners.add(name.owner);
      for (const taste of shortTastes) if (taste.person.test(lower) && stillTheirs(line, taste.forgotAt) === again) owners.add(taste.owner);
      return owners;
    };
    const ownersAt = history.map((line) => takenBy(line));
    // Where each thing was first said in the chat: a reply can only keep a thing's short value back from where it was said on
    const firstSaid = new Map<number, number>();
    ownersAt.forEach((owners, at) => owners.forEach((one) => firstSaid.set(one, Math.min(firstSaid.get(one) ?? at, at))));
    data.conversationHistory = history.filter((line, index) => {
      if (ownersAt[index].size > 0) return false;
      if (!isObject(line) || line.sender !== 'bot') return true;
      const text = textOf(line);
      const lower = text.toLowerCase();
      // The bot's own lines that say it go whenever they were said: when the thing goes, it was never the person's again, so the bot
      // can only have said it after the Forget while it still held it by mistake
      // (a reply right after the person said it again after the Forget is answering them, and stays with their line)
      const earlierLine = index > 0 ? history[index - 1] : null;
      // Only the things the person said again are let be: a stale line that says another forgotten thing still goes
      const saidAgain = earlierLine !== null ? takenBy(earlierLine, true) : new Set<number>();
      if (phrases.some((phrase) => !phrase.person && !saidAgain.has(phrase.owner) && phrase.text.test(phrase.exact ? text : lower))) return false;
      if (shortNames.some((name) => !saidAgain.has(name.owner) && name.bot.test(name.exact ? text : lower))) return false;
      if (shortTastes.some((taste) => !saidAgain.has(taste.owner) && taste.bot.test(lower))) return false;
      // The bot's reply right after a line a thing took, when it says a short value back of that thing or of any other forgotten thing the
      // person had already said ("I like tea" / "Tea it is!", "I'm ill" / "Sorry you are ill", "I like jam" / "I like tea" / "Have it with jam!").
      // A thing said only later is not in it ("I like tea" / "Jam is nice too" / "I like jam").
      if (index === 0 || ownersAt[index - 1].size === 0) return true;
      const alreadySaid = (owner: number) => (firstSaid.get(owner) ?? Infinity) <= index - 1;
      return !(shortTastes.some((taste) => alreadySaid(taste.owner) && taste.word.test(lower)) || shortOthers.some((other) => alreadySaid(other.owner) && other.word.test(lower)));
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
