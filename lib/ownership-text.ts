/** Words for passing a universe on (#820), shared by the member page and the Memberships page. */

/** What moves with the universe, in a phrase: the worlds are named, since a world or room can't be passed on its own. */
export function whatMoves(worldNames: readonly string[]): string {
  if (worldNames.length === 0) return 'every room in it';
  if (worldNames.length === 1) return `the world ${worldNames[0]} and every room in it`;
  return `its ${worldNames.length} worlds and every room in them`;
}

/** The same from a count, for a person who is not yet in the universe's worlds and so is not told their names. */
export function whatMovesCount(worlds: number): string {
  if (worlds === 0) return 'every room in it';
  if (worlds === 1) return 'its world and every room in it';
  return `its ${worlds} worlds and every room in them`;
}

/** The owner row on a member page: when they got the universe and from whom, or that they created it. */
export function ownerSinceLine(input: { universeName: string; isYou: boolean; since: string | null; from: string | null; day: (date: Date) => string }): string {
  if (!input.since) return `${input.isYou ? 'You created' : 'Created'} ${input.universeName}`;
  const when = input.day(new Date(input.since));
  return `Since ${when}${input.from ? ` · from ${input.from}` : ''}`;
}
