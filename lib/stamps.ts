/** Passport stamps, shared by the server and the browser (lib/passport.ts reads the database, so it stays server-side). */

/** The stamps on the passport the card shows in the game, and on You. */
export const CARD_STAMPS = 3;

/**
 * How long the longest word in a world's name is, for the stamps (the game card's, You's and the full passport): a word
 * too long for its stamp gets smaller type, so "SHOPFRONT" never breaks into "SHOPFRON / T". Undefined when it fits as it is.
 */
export function stampNameLength(name: string): 'long' | 'longer' | undefined {
  const longest = Math.max(0, ...name.split(/\s+/).map((word) => word.length));
  if (longest > 11) return 'longer';
  if (longest > 8) return 'long';
  return undefined;
}
