/**
 * Each universe's own shade, for its planet: picked from its id, so the same universe looks the same on every page
 * and never changes with the order of a list. Only violets, magentas and indigos, so a universe never looks like a
 * world (teal), a room (amber), a star (gold) or a person (sky).
 */
export const UNIVERSE_COLOURS = ['#8b5cf6', '#6366f1', '#a855f7', '#d946ef', '#7c3aed', '#4f46e5', '#c084fc', '#e879f9'] as const;

export function universeColour(id: string | null | undefined): string {
  if (!id) return UNIVERSE_COLOURS[0];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return UNIVERSE_COLOURS[Math.abs(hash) % UNIVERSE_COLOURS.length];
}
