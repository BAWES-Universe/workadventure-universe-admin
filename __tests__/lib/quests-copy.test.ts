/**
 * The quest preview speaks only in the game's words: every key Orbit reads must exist in every vendored locale, with
 * the parameters Orbit fills.
 */
import { QUEST_COPY_KEYS, QUEST_COPY_LOCALES, QUEST_PATH_COPY, formatQuestCopy, questCopy, questCopyStrings } from '@/lib/quests/copy';

const PARAMETERS: Partial<Record<(typeof QUEST_COPY_KEYS)[number], string[]>> = {
  minutes: ['minutes'],
  'paths.explore.description': ['area'],
  'paths.explore.payoff': ['area'],
  'stamps.badge': ['stamp'],
  'log.fromHost': ['host', 'room'],
  'log.here': ['room'],
  'log.progress': ['done', 'total'],
};

describe('vendored quest copy', () => {
  it.each(QUEST_COPY_LOCALES)('%s has every key the preview uses, none empty', (locale) => {
    const strings = questCopyStrings(locale);
    for (const key of QUEST_COPY_KEYS) {
      expect({ key, value: typeof strings[key] === 'string' && strings[key].trim() !== '' }).toEqual({ key, value: true });
    }
  });

  it.each(QUEST_COPY_LOCALES)('%s keeps the parameters Orbit fills', (locale) => {
    const strings = questCopyStrings(locale);
    for (const [key, names] of Object.entries(PARAMETERS)) {
      for (const name of names!) expect({ key, has: strings[key].includes(`{${name}}`) }).toEqual({ key, has: true });
    }
  });

  it('names every path key the pages use', () => {
    for (const copy of Object.values(QUEST_PATH_COPY)) {
      for (const key of Object.values(copy)) expect(QUEST_COPY_KEYS).toContain(key);
    }
  });

  it('reads the game’s own words, with this room’s names', () => {
    expect(questCopy('invitation.line')).toBe('Welcome. Want a quick look around?');
    expect(questCopy('paths.explore.description', { area: 'Courtyard' })).toBe('Find the Courtyard.');
    expect(questCopy('stamps.badge', { stamp: questCopy('stamps.meet') })).toBe('First Hello badge');
    expect(questCopy('paths.explore.description', { area: 'Courtyard' }, 'fr-FR')).toContain('Courtyard');
  });
});

describe('formatQuestCopy', () => {
  it('fills parameters and leaves unknown ones as they are', () => {
    expect(formatQuestCopy('From {host} · {room}', { host: 'Nova', room: 'Lobby' })).toBe('From Nova · Lobby');
    expect(formatQuestCopy('Find the {area}.')).toBe('Find the {area}.');
  });

  it('follows typesafe-i18n plurals on the number before them', () => {
    expect(formatQuestCopy('{count} accepted quest{{s}}', { count: 1 })).toBe('1 accepted quest');
    expect(formatQuestCopy('{count} accepted quest{{s}}', { count: 3 })).toBe('3 accepted quests');
    expect(formatQuestCopy('{n} {{step|steps}}', { n: 1 })).toBe('1 step');
    expect(formatQuestCopy('{n} {{step|steps}}', { n: 2 })).toBe('2 steps');
  });
});
