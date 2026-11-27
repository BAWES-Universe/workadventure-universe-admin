import type { Heading, Setting } from '@/lib/mcp-tool-policy';

/**
 * How Universe sorts a ready-made App's actions under the four headings bots already use (game "Ask, Do, Ignore" for Bricks). Once per App,
 * shared by everyone; the person then picks Right away, Asks first or Off per heading, and per action when they want.
 *
 *  1. The name comes first and always wins: an action whose slug has a word that sends, replies, forwards, deletes, trashes, removes,
 *     pays, buys, publishes, shares or invites is under "Deletes or sends out", whatever the provider's tags say.
 *  2. The provider's own tags (read live 26 Nov 2026 on GET /api/v3.1/tools: readOnlyHint, createHint, updateHint, destructiveHint):
 *     destructive is Deletes or sends out, update is Changes things, read-only is Looks things up. More than one: the strictest.
 *  3. create is Changes things (something others may see), except an action Universe knows stays private to the person (a draft, a
 *     private label: PRIVATE_ACTIONS), which is Makes new things.
 *  4. No tag: the small model bots already use sorts it (the bot server, through /api/app-actions/unsorted); it may pick Makes new
 *     things only for an action on the private list. Until it answers: Deletes or sends out.
 *  Anything unclear goes under the stricter heading.
 */

const ORDER: readonly Heading[] = ['looksUp', 'makesNew', 'changesThings', 'deletesOrSends'];

/** The stricter of two headings (the later one in the list). */
export function stricterHeading(a: Heading, b: Heading): Heading {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/** Words that make an action a send, a delete or a spend, whatever else it says. Matched as a whole word of the slug. */
const SENDS_OR_DELETES = new Set([
  'SEND', 'SENDS',
  'REPLY', 'REPLIES',
  'FORWARD', 'FORWARDS',
  'DELETE', 'DELETES',
  'TRASH',
  'REMOVE', 'REMOVES',
  'PAY', 'PAYS', 'PAYMENT', 'PAYMENTS', 'PAYOUT', 'PAYOUTS',
  'PURCHASE', 'PURCHASES',
  'BUY', 'BUYS',
  'PUBLISH', 'PUBLISHES',
  'SHARE', 'SHARES',
  'INVITE', 'INVITES',
]);

const wordsOf = (slug: string): string[] => slug.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/** Deletes or sends out when the slug's words say so; null when they don't. */
export function nameRule(slug: string): Heading | null {
  return wordsOf(slug).some((word) => SENDS_OR_DELETES.has(word)) ? 'deletesOrSends' : null;
}

/**
 * Actions Universe knows stay private to the person, per App (the toolkit's slug): what they make only they see until they do
 * something else with it. Read live from the provider's list on 26 Nov 2026. An action not here that makes something is Changes things.
 */
export const PRIVATE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  gmail: ['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_CREATE_LABEL'],
  outlook: ['OUTLOOK_CREATE_DRAFT'],
};

export const isPrivateAction = (toolkit: string, slug: string): boolean => (PRIVATE_ACTIONS[toolkit.toLowerCase()] ?? []).includes(slug.toUpperCase());

export type SortSource = 'name' | 'tag' | 'sorter' | 'fallback';

/** The heading the provider's tags give, or null when it gave none of the four. */
export function headingFromTags(toolkit: string, slug: string, tags: readonly string[]): Heading | null {
  const has = new Set(tags);
  const picks: Heading[] = [];
  if (has.has('destructiveHint')) picks.push('deletesOrSends');
  if (has.has('updateHint')) picks.push('changesThings');
  if (has.has('createHint')) picks.push(isPrivateAction(toolkit, slug) ? 'makesNew' : 'changesThings');
  if (has.has('readOnlyHint')) picks.push('looksUp');
  return picks.length === 0 ? null : picks.reduce(stricterHeading);
}

/** Where an action goes before the sorter has seen it. */
export function sortAction(toolkit: string, slug: string, tags: readonly string[]): { heading: Heading; source: SortSource } {
  const byName = nameRule(slug);
  if (byName) return { heading: byName, source: 'name' };
  const byTags = headingFromTags(toolkit, slug, tags);
  if (byTags) return { heading: byTags, source: 'tag' };
  return { heading: 'deletesOrSends', source: 'fallback' };
}

/** What the small model's pick becomes: Makes new things only for an action on the private list (else Changes things), and never looser than the name says. */
export function acceptSorterPick(toolkit: string, slug: string, pick: Heading): Heading {
  const byName = nameRule(slug);
  if (byName) return byName;
  if (pick === 'makesNew' && !isPrivateAction(toolkit, slug)) return 'changesThings';
  return pick;
}

/**
 * Plain words for an action, from its slug: the App's own prefix comes off when it matches the App ("GMAIL_FETCH_EMAILS" with
 * "gmail" gives "Fetch emails"), the rest in lower case with a capital first letter. The same rule as the game's card titles.
 */
export function actionTitle(toolkit: string, slug: string): string {
  const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = slug.split(/_+/).filter(Boolean);
  // The longest run of leading words that spells the App's name ("GOOGLE_CALENDAR_..." or "GOOGLECALENDAR_..." with "googlecalendar")
  const app = letters(toolkit);
  let cut = 0;
  for (let i = 1; i < parts.length; i += 1) {
    if (letters(parts.slice(0, i).join('')) === app) {
      cut = i;
      break;
    }
  }
  const words = (cut > 0 ? parts.slice(cut) : parts).join(' ').toLowerCase().trim();
  const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
  return withoutProvider(title).slice(0, 255);
}

/** The provider's name never shows: taken out of any words shown to people, with the spaces tidied. */
export function withoutProvider(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/)?[\w.-]*composio[\w.-]*\.[a-z]{2,}(?:\/[^\s)]*)?/gi, '')
    .replace(/\bcomposio(?:hq)?\b(['’]s)?/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

/** What an action's setting is on a grant: its own choice when it has one, else its heading's. */
export function effectiveSetting(own: Setting | null | undefined, heading: Heading, settings: Record<Heading, Setting>): Setting {
  return own ?? settings[heading];
}
