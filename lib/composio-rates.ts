/**
 * What Composio charges us for a ready-made app step: ONE table to update when its published prices change, and the rule that
 * turns a call into a price. No database in here, so the meter, the account's monthly bill and the tests read the same numbers.
 *
 * Source: composio.dev/pricing/platform, composio.dev/pricing and docs.composio.dev, re-read 14 Nov 2026. Money is in millionths
 * of a dollar ("micros"): $0.0005 is 500.
 *
 * WHAT THE PAGE SAYS, AND WHERE IT DOES NOT SETTLE (kept honest here, not guessed away). The "Composio-managed apps" block on
 * /pricing/platform reads, in page order: [Salesforce, YouTube, Reddit, Google Ads, QuickBooks, LinkedIn, Zoho Books, Gong, Zoho
 * Inventory, Google Photos, Zoho Invoice, Moneybird, Blackbaud] "$0.002 credits / tool call after 20K free" [Gmail, Google
 * Calendar, Google Super, Microsoft Teams, Google Drive, HubSpot, Slack, Google Sheets, Jira, Trello, Discord Bot, TikTok Ads,
 * Confluence, Stack Exchange] "$0.0005 credits / tool call after 20K free" ["All other Composio-managed apps"] "From $0.01
 * credits / tool call" [Google Maps: "Charged from the first call, outside the free 20K"]. The text does not say whether a price
 * label belongs to the app list before it or after it, and a third-party summary quoting Composio says "$0.0005 to $0.01 per call
 * after 20,000 free depending on the app ($0.002 for Gmail, Slack or HubSpot)". So:
 *  - Gmail and its group are $0.002 on the readings that agree with that quote and $0.0005 on the other. Held at $0.002.
 *  - Apps the page does not name ("all other") are $0.0005 on one reading and "from $0.01" on the other; the quote says the
 *    price depends on the app, anywhere from $0.0005 to $0.01. Held at the top of that range, $0.01.
 *  - The Salesforce group's own label is not readable in the page text ($0.002 on one reading, nothing on the other). Held at $0.01.
 *  - Google Maps is "from $0.01" (the page says it varies by API): $0.01 is a floor, so it is not settled either.
 * Every Composio-managed price is therefore said to be UNSETTLED (`verified: false`) until the first monthly check against
 * Composio's own invoice or the dashboard's per-app rates. Each figure is the higher one, so reported margin is never better than
 * it is. Our own 16 apps by group are pinned in __tests__/lib/composio-rates.test.ts.
 *  - The page says per-app prices for managed apps apply to signups on or after 3 Nov 2026. Whether our account is under that
 *    rule is not stated.
 *  - Direct execution (a tool run outside a Session, which is how Orbit runs a single app step) adds $0.0001 a call on Pro.
 *  - Whether the sandbox's own 10,000 free runs apply on Pro, and whether a sandbox run is also a tool call, are not stated:
 *    a run is priced as the add-on only ($0.0001), with no free runs taken off.
 *  - Whether a batch call (COMPOSIO_MULTI_EXECUTE_TOOL) is itself an execution besides the tools inside it is not stated: only
 *    the tools inside are priced.
 */

export const COMPOSIO_RATES_READ_ON = '2026-11-14';
export const COMPOSIO_RATES_SOURCE = 'composio.dev/pricing/platform';

export type RateTier = 'own' | 'managed_other' | 'managed_listed' | 'managed_premium' | 'managed_maps';

/** A tool call by tier, in micros. Every Composio-managed figure is the HIGHER of the readings the page allows (see above). */
export const RATE_MICROS: Record<RateTier, number> = {
  /** Our own sign-in app or an API-key app, on Pro. */
  own: 300,
  /** "All other Composio-managed apps": $0.0005 or "from $0.01" depending on the reading; the top of Composio's stated range. */
  managed_other: 10_000,
  /** Gmail, Google Calendar, Drive, Sheets, Slack, HubSpot, Trello and the like: $0.002 or $0.0005 depending on the reading. */
  managed_listed: 2_000,
  /** Salesforce, YouTube, Reddit, LinkedIn and the like: the label is not readable in the page text; the top of the stated range. */
  managed_premium: 10_000,
  /** Google Maps, "from $0.01": the starting price, charged from the first call. */
  managed_maps: 10_000,
};

/** Add-ons on Pro, per call. ZDR covers only apps that do NOT use Composio's own sign-in; the sandbox is never covered. */
export const ZDR_ADD_ON_MICROS = 100;
export const SANDBOX_RUN_MICROS = 100;
/** Running a tool outside a Session (Orbit's single app step), per run on Pro. */
export const DIRECT_EXECUTION_MICROS = 100;

/** Free each month: 100,000 tool calls in all, of which at most 20,000 on Composio's own sign-in apps. Pro adds a monthly credit that does not roll over. */
export const FREE_TOOL_CALLS_PER_MONTH = 100_000;
export const FREE_MANAGED_CALLS_PER_MONTH = 20_000;
export const PRO_PLAN_FEE_MICROS = 29_000_000;
export const PRO_PLAN_CREDIT_MICROS = 29_000_000;

/** Toolkit slugs the page names, by tier. An app not named anywhere is "all other managed apps". */
const LISTED_GROUP = [
  'gmail', 'googlecalendar', 'googlesuper', 'microsoft_teams', 'microsoftteams', 'googledrive', 'hubspot', 'slack', 'googlesheets',
  'jira', 'trello', 'discordbot', 'tiktok_ads', 'tiktokads', 'confluence', 'stack_exchange', 'stackexchange',
];
const PREMIUM_GROUP = [
  'salesforce', 'youtube', 'reddit', 'googleads', 'google_ads', 'quickbooks', 'linkedin', 'zoho_books', 'zohobooks', 'gong', 'zoho_inventory',
  'zohoinventory', 'googlephotos', 'google_photos', 'zoho_invoice', 'zohoinvoice', 'moneybird', 'blackbaud',
];
const MAPS_GROUP = ['googlemaps', 'google_maps'];

export function tierOf(toolkit: string, ownAuth: boolean): { tier: RateTier; verified: boolean } {
  const key = toolkit.toLowerCase();
  if (ownAuth) return { tier: 'own', verified: true };
  // Every Composio-managed price is one the page does not settle: priced at the higher reading, and said to be unverified
  if (PREMIUM_GROUP.includes(key)) return { tier: 'managed_premium', verified: false };
  if (MAPS_GROUP.includes(key)) return { tier: 'managed_maps', verified: false };
  if (LISTED_GROUP.includes(key)) return { tier: 'managed_listed', verified: false };
  return { tier: 'managed_other', verified: false };
}

/** Composio's own search and schema lookups: "Meta tools such as tool search are free". Anything else that starts with COMPOSIO_ and is not named below is NOT assumed free. */
const FREE_META_TOOLS = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MANAGE_CONNECTIONS']);
/** Running code in the provider's sandbox. */
const SANDBOX_TOOLS = new Set(['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL']);
/** One call that runs up to 50 other tools. */
const BATCH_TOOL = 'COMPOSIO_MULTI_EXECUTE_TOOL';
export const BATCH_MAX = 50;

export interface PricedCall {
  /** What it is: nothing to pay (a search or lookup), a batch of tool runs, a sandbox run, or one tool run. */
  kind: 'free' | 'execution' | 'sandbox' | 'batch';
  /** Tool runs that count once each at the toolkit's rate. */
  executions: number;
  /** Sandbox runs, each at the add-on price. */
  sandboxRuns: number;
  tier: RateTier;
  /** False while the tier is one the page does not settle. */
  tierVerified: boolean;
  /** Tool runs that also carry the zero data retention add-on. */
  zdrCalls: number;
  /** Tool runs that also carry the direct execution add-on (run outside a Session). */
  directCalls: number;
  /** The slugs run inside a batch, counted (never their arguments). */
  inner: Record<string, number>;
  /** What the call costs at list price, before the free allowance and the plan's credit. */
  listMicros: number;
}

/** The tool slugs inside a batch call's arguments, never the arguments themselves. A batch whose list cannot be read counts as one tool run. */
function innerSlugs(args: unknown): string[] {
  const list = args && typeof args === 'object' ? (args as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(list)) return [];
  const slugs: string[] = [];
  for (const entry of list.slice(0, BATCH_MAX)) {
    const slug = entry && typeof entry === 'object' ? (entry as { tool_slug?: unknown }).tool_slug : undefined;
    slugs.push(typeof slug === 'string' && slug ? slug.slice(0, 120) : 'unknown');
  }
  return slugs;
}

export interface PriceInput {
  toolkit: string;
  tool: string;
  /** The call's arguments: read only to count the tools inside a batch. */
  arguments?: unknown;
  /** The call is one tool run outside a Session (`/tools/execute`), not a message of an app link's session. */
  direct?: boolean;
  /** The app signs in through our own (or an API-key) setup, not Composio's. */
  ownAuth: boolean;
  /** Zero data retention is switched on for the project. */
  zdrOn: boolean;
}

/** What one call to an app is, and what it costs at list price. A free call is written with 0 and no tool runs, never as a paid use. */
export function priceCall(input: PriceInput): PricedCall {
  const { tier, verified } = tierOf(input.toolkit, input.ownAuth);
  const rate = RATE_MICROS[tier];
  const zdrEach = input.zdrOn && input.ownAuth ? ZDR_ADD_ON_MICROS : 0;
  const base = { tier, tierVerified: verified, inner: {} as Record<string, number> };

  const tool = input.tool.toUpperCase();
  if (FREE_META_TOOLS.has(tool)) return { ...base, kind: 'free', executions: 0, sandboxRuns: 0, zdrCalls: 0, directCalls: 0, listMicros: 0 };
  if (SANDBOX_TOOLS.has(tool)) return { ...base, kind: 'sandbox', executions: 0, sandboxRuns: 1, zdrCalls: 0, directCalls: 0, listMicros: SANDBOX_RUN_MICROS };

  if (tool === BATCH_TOOL) {
    const slugs = innerSlugs(input.arguments);
    const counted = slugs.length > 0 ? slugs : ['unknown'];
    const inner: Record<string, number> = {};
    let executions = 0;
    let sandboxRuns = 0;
    for (const slug of counted) {
      inner[slug] = (inner[slug] ?? 0) + 1;
      const upper = slug.toUpperCase();
      if (FREE_META_TOOLS.has(upper)) continue;
      if (SANDBOX_TOOLS.has(upper)) sandboxRuns += 1;
      else executions += 1;
    }
    return { ...base, kind: 'batch', inner, executions, sandboxRuns, zdrCalls: zdrEach ? executions : 0, directCalls: 0, listMicros: executions * (rate + zdrEach) + sandboxRuns * SANDBOX_RUN_MICROS };
  }

  // Any other tool name is one run of that tool. An unknown COMPOSIO_ tool is not assumed free: unknown prices are never zero.
  // A single tool run sent outside a session also carries the direct execution add-on.
  const directEach = input.direct ? DIRECT_EXECUTION_MICROS : 0;
  return { ...base, kind: 'execution', executions: 1, sandboxRuns: 0, zdrCalls: zdrEach ? 1 : 0, directCalls: directEach ? 1 : 0, listMicros: rate + zdrEach + directEach };
}
