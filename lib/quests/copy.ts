import enUS from './quest-copy.en-US.json';
import frFR from './quest-copy.fr-FR.json';
import arSA from './quest-copy.ar-SA.json';

/**
 * The game's player strings (vendored, see README.md). Orbit shows quests with these words and never its own, so the
 * owner's preview and the You page read exactly as the game does.
 */
export const QUEST_COPY_LOCALES = ['en-US', 'fr-FR', 'ar-SA'] as const;
export type QuestCopyLocale = (typeof QUEST_COPY_LOCALES)[number];

/** Every key Orbit reads. The copy test checks each exists in every vendored locale. */
export const QUEST_COPY_KEYS = [
  'quests',
  'welcome',
  'minutes',
  'invitation.line',
  'invitation.secondary',
  'invitation.showOptions',
  'invitation.notNow',
  'options.title',
  'paths.meet.title',
  'paths.meet.description',
  'paths.meet.payoff',
  'paths.meet.payoffNeutral',
  'paths.explore.title',
  'paths.explore.description',
  'paths.explore.payoff',
  'paths.build.title',
  'paths.build.description',
  'paths.build.payoff',
  'stamps.meet',
  'stamps.explore',
  'stamps.build',
  'stamps.badge',
  'log.inProgress',
  'log.done',
  'log.onMap',
  'log.progress',
  'log.fromHost',
  'log.here',
] as const;
export type QuestCopyKey = (typeof QUEST_COPY_KEYS)[number];

/** Each path's title, one-line description and stamp name. */
export const QUEST_PATH_COPY: Record<'meet' | 'explore' | 'build', { title: QuestCopyKey; description: QuestCopyKey; stamp: QuestCopyKey }> = {
  meet: { title: 'paths.meet.title', description: 'paths.meet.description', stamp: 'stamps.meet' },
  explore: { title: 'paths.explore.title', description: 'paths.explore.description', stamp: 'stamps.explore' },
  build: { title: 'paths.build.title', description: 'paths.build.description', stamp: 'stamps.build' },
};

interface CopyFile {
  locale: string;
  strings: Record<string, string>;
}

const FILES: Record<QuestCopyLocale, CopyFile> = { 'en-US': enUS, 'fr-FR': frFR, 'ar-SA': arSA };

export function questCopyStrings(locale: QuestCopyLocale): Record<string, string> {
  return FILES[locale].strings;
}

export function questCopyDirection(locale: QuestCopyLocale): 'ltr' | 'rtl' {
  return locale === 'ar-SA' ? 'rtl' : 'ltr';
}

/**
 * Fills a typesafe-i18n string: `{name}` takes a parameter; `{{s}}` and `{{one|other}}` follow the number before them.
 */
export function formatQuestCopy(text: string, params: Record<string, string | number> = {}): string {
  let lastNumber: number | null = null;
  return text.replace(/\{\{([^}]*)\}\}|\{(\w+)\}/g, (match, plural: string | undefined, name: string | undefined) => {
    if (name !== undefined) {
      const value = params[name];
      if (value === undefined) return match;
      if (typeof value === 'number') lastNumber = value;
      return String(value);
    }
    const [one, other] = plural!.includes('|') ? plural!.split('|') : ['', plural!];
    return lastNumber === 1 ? one : other;
  });
}

/**
 * A name set into a sentence (a room, area or host), kept apart from the sentence's direction (FSI…PDI), so a Latin
 * name in Arabic copy, or the reverse, doesn't take its neighbours' punctuation with it.
 */
export function isolateName(name: string): string {
  return `\u2068${name}\u2069`;
}

/** One player string in the given language (English when a locale lacks it, as in the game). */
export function questCopy(
  key: QuestCopyKey,
  params?: Record<string, string | number>,
  locale: QuestCopyLocale = 'en-US',
): string {
  const text = FILES[locale].strings[key] ?? FILES['en-US'].strings[key] ?? key;
  return formatQuestCopy(text, params);
}
