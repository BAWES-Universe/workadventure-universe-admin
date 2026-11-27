import { dollars } from '@/lib/costs-words';
import type { AppRow, CostCompleteness } from '@/lib/app-demand';

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

/** The App key GitHub has on this page (the same key the ready-made list uses). */
export const GITHUB_APP_KEY = 'github';

/** Universe's own GitHub App on the Apps page (game #2041): the words of GitHub's row and its sheet, written once. */
export const githubAppWords = {
  /** Under the GitHub row until the App is made, and after. The row itself still says what it runs on: people who connected GitHub before still use that connection. */
  rowHintBefore: 'Tap to set up Universe’s GitHub App',
  rowHintAfter: 'New connections use Universe’s GitHub App',
  title: 'Universe’s GitHub App',
  button: 'Set up Universe’s GitHub App',
  /** Before it is made. */
  notMade: 'GitHub runs on the current App connection today. Set up Universe’s GitHub App so people connect GitHub through Universe. You press Create once on GitHub’s page, and GitHub connections people already made keep running as they do now.',
  /** Once it is made. */
  madeStatus: 'Set up',
  made: 'People connect GitHub through it, and their Bricks work on GitHub as them.',
  openOnGitHub: 'Open on GitHub',
  /** Under "Runs on" once it is made: the choice below is for the older connections only. */
  runsOnOnly: 'Only for GitHub connections people made before.',
  /** The Universe choice's line once it is made, instead of "no version of our own yet". */
  universeLine: 'New connections use Universe’s GitHub App above.',
} as const;

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

/** The label under the headline cost: a total that is a part of the cost says so, and one built on estimates says that. Never the plain label for a part. */
export function costTotalLabel(cost: CostCompleteness): string {
  if (cost.state === 'incomplete') return 'cost to us so far';
  if (cost.state === 'correcting') return 'cost to us (being corrected)';
  return cost.state === 'estimated' ? 'cost to us (partly estimated)' : 'cost to us';
}

/** What the headline leaves out or has estimated, in words, or null when it is whole and measured. */
export function costTotalNote(cost: CostCompleteness): string | null {
  const parts: string[] = [];
  if (cost.unpriced > 0) parts.push(`${plural(cost.unpriced, 'use has', 'uses have')} no price yet`);
  if (cost.notCounted > 0) parts.push(`${plural(cost.notCounted, 'run is', 'runs are')} not in this total yet (still being settled)`);
  const fixing = cost.mismatched > 0 ? `${plural(cost.mismatched, 'run is', 'runs are')} counted at a figure that differs from the provider’s own, and will be corrected` : null;
  // Runs that are counted at a wrong figure are in the total, so they never make it "only part of it": that is said of the ones that are not in it
  if (parts.length > 0) return `The cost so far is only part of it: ${parts.join(' and ')}.${fixing ? ` Also, ${fixing}.` : ''}`;
  if (fixing) return `${fixing[0].toUpperCase()}${fixing.slice(1)}.`;
  if (cost.estimated > 0) return `${plural(cost.estimated, 'use is', 'uses are')} priced with our estimate until the provider’s own figure is in.`;
  return null;
}
