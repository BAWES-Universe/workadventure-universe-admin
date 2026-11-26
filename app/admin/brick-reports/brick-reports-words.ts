import type { Level, ReportArea, ReportKind, ReportState } from '@/lib/brick-reports';

/** The words the Brick reports screens use, in one place. */
export const KIND_WORDS: Record<ReportKind, string> = { problem: 'Problem', cant_do: 'Can’t do', friction: 'Friction', idea: 'Idea' };
export const AREA_WORDS: Record<ReportArea, string> = {
  apps: 'Apps',
  computer: 'Computer',
  pages: 'Pages',
  chat: 'Chat',
  voice: 'Voice',
  map: 'Map',
  memory: 'Memory',
  files: 'Files',
  credit: 'Credit',
  other: 'Other',
};
export const LEVEL_WORDS: Record<Level, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const STATE_WORDS: Record<ReportState, string> = { new: 'New', working: 'Working on', fixed: 'Fixed' };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "9 Bricks · 14 people". */
export const whoLine = (bricks: number, people: number) => (people > 0 ? `${plural(bricks, 'Brick', 'Bricks')} · ${plural(people, 'person', 'people')}` : plural(bricks, 'Brick', 'Bricks'));

/** A day as "19 Nov", in the reader's own time zone. */
export const dayWords = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
