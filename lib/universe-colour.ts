/**
 * Each universe's own colour: picked from its id, so the same universe is the same colour on every page and never
 * changes with the order of a list. On-brand hues that read on navy and on white.
 */
export const UNIVERSE_COLOURS = ['#8b5cf6', '#6366f1', '#38bdf8', '#14b8a6', '#f59e0b', '#f43f5e', '#ec4899', '#22c55e'] as const;

export function universeColour(id: string | null | undefined): string {
  if (!id) return UNIVERSE_COLOURS[0];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return UNIVERSE_COLOURS[Math.abs(hash) % UNIVERSE_COLOURS.length];
}
