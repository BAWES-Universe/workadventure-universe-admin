import { dollars } from '@/lib/costs-words';
import type { AppRow } from '@/lib/app-demand';

/** The plain words of the "Apps: use and demand" page, written once. Wording is only "Apps": never tool, MCP or connector. */

const plural = (value: number, one: string, many: string) => `${value.toLocaleString('en')} ${value === 1 ? one : many}`;

export const kindWords = (kind: AppRow['kind']): string => (kind === 'instant' ? 'Instant' : 'Their own account');

/** "3,210 uses · 240 people · Instant" */
export function usesLine(app: Pick<AppRow, 'uses' | 'people' | 'kind'>): string[] {
  return [plural(app.uses, 'use', 'uses'), plural(app.people, 'person', 'people'), kindWords(app.kind)];
}

/** The share of ended runs that failed, as "4%" ("<1%" for a few, never a false "0%" when some failed), or null when no ending is known. */
export function failedWords(app: Pick<AppRow, 'ended' | 'failed'>): string | null {
  if (app.ended === 0) return null;
  if (app.failed === 0) return '0% failed';
  const share = (app.failed / app.ended) * 100;
  return share < 1 ? '<1% failed' : `${Math.round(share)}% failed`;
}

/** "$118.40 to us · 4% failed". An App with no priced run says so instead of "$0.00". */
export function costLine(app: Pick<AppRow, 'costMicros' | 'unpriced' | 'ended' | 'failed' | 'uses'>): string[] {
  // A total that leaves some runs out says so, the same as the sheet does: it is never shown as the whole cost
  const cost = app.costMicros === null ? (app.uses > 0 ? 'No price yet' : 'Not used yet') : app.unpriced > 0 ? `${dollars(app.costMicros)} to us so far` : `${dollars(app.costMicros)} to us`;
  return [cost, failedWords(app)].filter((part): part is string => !!part);
}

export const runsOnWords = (route: AppRow['route']): string => (route === 'universe' ? 'Runs on Universe' : 'Runs on Composio');

/** The detail line of an App's sheet: "412 uses · 96 people · 4% failed, all refunded". */
export function sheetLine(app: AppRow): string {
  const failed = failedWords(app);
  const refunded = app.failed > 0 ? (app.allFailedRefunded ? 'all refunded' : null) : null;
  return [plural(app.uses, 'use', 'uses'), plural(app.people, 'person', 'people'), failed && (refunded ? `${failed}, ${refunded}` : failed)].filter((part): part is string => !!part).join(' · ');
}

/** A route's cost: unknown is never shown as $0.00, and a partly known cost says so. */
function routeCost(side: { costMicros: number | null; unpriced: number }): string {
  if (side.costMicros === null) return 'No price yet';
  return side.unpriced > 0 ? `${dollars(side.costMicros)} so far, ${plural(side.unpriced, 'run has', 'runs have')} no price yet` : dollars(side.costMicros);
}

/** What the last days cost us on each route, for the sheet. */
export function byRouteLine(app: AppRow): string | null {
  const parts: string[] = [];
  for (const [route, label] of [['composio', 'Composio'], ['universe', 'Universe']] as const) {
    const side = app.byRoute[route];
    if (side.uses > 0) parts.push(`${routeCost(side)} on ${label} (${plural(side.uses, 'use', 'uses')})`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export const askedLine = (row: { times: number; people: number }): string => `${plural(row.times, 'time', 'times')} · by ${plural(row.people, 'person', 'people')}`;

export const dayWords = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
