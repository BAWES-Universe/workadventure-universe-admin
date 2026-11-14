import {
  DIRECT_EXECUTION_MICROS,
  FREE_MANAGED_CALLS_PER_MONTH,
  FREE_TOOL_CALLS_PER_MONTH,
  PRO_PLAN_CREDIT_MICROS,
  PRO_PLAN_FEE_MICROS,
  RATE_MICROS,
  SANDBOX_RUN_MICROS,
  ZDR_ADD_ON_MICROS,
  priceCall,
  tierIsSettled,
  tierOf,
} from '@/lib/composio-rates';
import { DEFAULT_READY_MADE_APPS } from '@/lib/app-adapter/settings';
import {
  COMPOSIO_BILLING_DEFAULTS,
  GAP_CALLS_MIN,
  GAP_INVOICE_MIN_MICROS,
  billFrom,
  callGapIsFlagged,
  invoiceGapIsFlagged,
  readEvent,
  readMonth,
  type ScannedEvent,
} from '@/lib/composio-billing';

const call = (over: Partial<Parameters<typeof priceCall>[0]> = {}) => priceCall({ toolkit: 'notion', tool: 'NOTION_SEARCH', ownAuth: false, zdrOn: false, ...over });

describe('the rate table', () => {
  it('has the provider’s published figures (composio.dev/pricing.md, 14 Nov 2026), in millionths of a dollar', () => {
    expect(RATE_MICROS).toEqual({ own: 300, managed_other: 500, managed_listed: 2000, managed_premium: 10_000, managed_maps: 10_000 });
    expect([ZDR_ADD_ON_MICROS, SANDBOX_RUN_MICROS, DIRECT_EXECUTION_MICROS]).toEqual([100, 100, 100]);
    expect([FREE_TOOL_CALLS_PER_MONTH, FREE_MANAGED_CALLS_PER_MONTH, PRO_PLAN_FEE_MICROS, PRO_PLAN_CREDIT_MICROS]).toEqual([100_000, 20_000, 29_000_000, 29_000_000]);
  });

  // Every group, by the apps the rate card names for it (composio.dev/pricing.md, read 14 Nov 2026)
  const GROUPS = {
    // $0.01 per call
    managed_premium: ['salesforce', 'youtube', 'reddit', 'googleads', 'google_ads', 'quickbooks', 'linkedin', 'zoho_books', 'zohobooks', 'gong', 'zoho_inventory', 'zohoinventory', 'googlephotos', 'google_photos', 'zoho_invoice', 'zohoinvoice', 'moneybird', 'blackbaud'],
    // $0.002 per call
    managed_listed: ['gmail', 'googlecalendar', 'googlesuper', 'microsoft_teams', 'microsoftteams', 'googledrive', 'hubspot', 'slack', 'googlesheets', 'jira', 'trello', 'discordbot', 'tiktok_ads', 'tiktokads', 'confluence', 'stack_exchange', 'stackexchange'],
    // "From $0.01" per call, charged from the first call
    managed_maps: ['googlemaps', 'google_maps'],
  } as const;

  it('puts every app the page names in its group, in any letter case', () => {
    for (const [tier, apps] of Object.entries(GROUPS)) {
      for (const app of apps) {
        expect(tierOf(app, false).tier).toBe(tier);
        expect(tierOf(app.toUpperCase(), false).tier).toBe(tier);
      }
    }
  });

  it('prices each group at its pinned rate: Salesforce group and Maps $0.01, Gmail group $0.002, any other app $0.0005, our own sign-in $0.0003', () => {
    expect(priceCall({ toolkit: 'salesforce', tool: 'SALESFORCE_CREATE_LEAD', ownAuth: false, zdrOn: false }).listMicros).toBe(10_000);
    expect(priceCall({ toolkit: 'gmail', tool: 'GMAIL_SEND_EMAIL', ownAuth: false, zdrOn: false }).listMicros).toBe(2_000);
    expect(priceCall({ toolkit: 'googlemaps', tool: 'GOOGLEMAPS_TEXT_SEARCH', ownAuth: false, zdrOn: false }).listMicros).toBe(10_000);
    expect(priceCall({ toolkit: 'notion', tool: 'NOTION_SEARCH', ownAuth: false, zdrOn: false }).listMicros).toBe(500);
    expect(priceCall({ toolkit: 'gmail', tool: 'GMAIL_SEND_EMAIL', ownAuth: true, zdrOn: false }).listMicros).toBe(300);
  });

  it('puts each of our 16 apps in its group', () => {
    const expected: Record<string, string> = {
      gmail: 'managed_listed', googlecalendar: 'managed_listed', googledrive: 'managed_listed', googlesheets: 'managed_listed', slack: 'managed_listed', trello: 'managed_listed', hubspot: 'managed_listed',
      googledocs: 'managed_other', outlook: 'managed_other', notion: 'managed_other', github: 'managed_other', linear: 'managed_other', asana: 'managed_other', airtable: 'managed_other', dropbox: 'managed_other', todoist: 'managed_other',
    };
    expect(Object.keys(expected).sort()).toEqual(DEFAULT_READY_MADE_APPS.map((app) => app.key).sort());
    for (const app of DEFAULT_READY_MADE_APPS) expect(tierOf(app.key, false).tier).toBe(expected[app.key]);
  });

  it('says only Google Maps is a price the rate card leaves open (from $0.01, by API): every other group is a settled figure', () => {
    for (const app of ['notion', 'salesforce', 'gmail', 'Slack', 'github']) expect(tierOf(app, false).verified).toBe(true);
    expect(tierOf('googlemaps', false)).toEqual({ tier: 'managed_maps', verified: false });
    expect(tierOf('gmail', true)).toEqual({ tier: 'own', verified: true });
    expect(tierOf('googlemaps', true)).toEqual({ tier: 'own', verified: true });
    expect(['own', 'managed_other', 'managed_listed', 'managed_premium'].every((tier) => tierIsSettled(tier as never))).toBe(true);
    expect(tierIsSettled('managed_maps')).toBe(false);
  });

  it('prices GitHub as any other app while it is still run through Composio, and its own route (Universe’s GitHub App, #944) is never priced here', () => {
    expect(tierOf('github', false)).toEqual({ tier: 'managed_other', verified: true });
    expect(priceCall({ toolkit: 'github', tool: 'GITHUB_CREATE_AN_ISSUE', ownAuth: false, zdrOn: false }).listMicros).toBe(500);
    // The GitHub App's calls are metered on route 'github' at 0 by lib/github/link.ts and never reach priceCall
  });
});

describe('pricing one call', () => {
  it('counts a tool run once at its app’s rate', () => {
    expect(call({ tool: 'NOTION_SEARCH_NOTION_PAGE' })).toMatchObject({ kind: 'execution', executions: 1, sandboxRuns: 0, listMicros: 500, zdrCalls: 0, directCalls: 0 });
    expect(call({ toolkit: 'salesforce', tool: 'SALESFORCE_CREATE_LEAD' }).listMicros).toBe(10_000);
    expect(call({ toolkit: 'gmail', tool: 'GMAIL_SEND_EMAIL' }).listMicros).toBe(2000);
    expect(call({ ownAuth: true }).listMicros).toBe(300);
  });

  it('never charges a search or lookup: Composio says meta tools such as tool search are free', () => {
    for (const tool of ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'COMPOSIO_MANAGE_CONNECTIONS', 'composio_search_tools']) {
      expect(call({ tool })).toMatchObject({ kind: 'free', executions: 0, sandboxRuns: 0, listMicros: 0 });
    }
  });

  it('counts a sandbox run as the add-on, nothing more', () => {
    for (const tool of ['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL']) {
      expect(call({ tool, ownAuth: true, zdrOn: true })).toMatchObject({ kind: 'sandbox', executions: 0, sandboxRuns: 1, zdrCalls: 0, listMicros: 100 });
    }
  });

  it('does not take an unknown COMPOSIO_ tool for free', () => {
    expect(call({ tool: 'COMPOSIO_SOMETHING_NEW' })).toMatchObject({ kind: 'execution', executions: 1, listMicros: 500 });
  });

  it('adds the zero data retention add-on only where it covers: our own sign-in or an API key, and only with it switched on', () => {
    expect(call({ ownAuth: true, zdrOn: true })).toMatchObject({ executions: 1, zdrCalls: 1, listMicros: 400 });
    expect(call({ ownAuth: true, zdrOn: false })).toMatchObject({ zdrCalls: 0, listMicros: 300 });
    // Composio's own sign-in is not covered on Pro, switch or no switch
    expect(call({ ownAuth: false, zdrOn: true })).toMatchObject({ zdrCalls: 0, listMicros: 500 });
  });

  it('adds the direct execution add-on to a single tool run sent outside a session, on any app, and to nothing else', () => {
    expect(call({ direct: true })).toMatchObject({ executions: 1, directCalls: 1, listMicros: 500 + 100 });
    expect(call({ direct: true, ownAuth: true })).toMatchObject({ directCalls: 1, listMicros: 300 + 100 });
    expect(call({ direct: true, ownAuth: true, zdrOn: true })).toMatchObject({ zdrCalls: 1, directCalls: 1, listMicros: 300 + 100 + 100 });
    expect(call({ direct: false })).toMatchObject({ directCalls: 0, listMicros: 500 });
    // A free lookup, a sandbox run and a batch (all messages of a session) never carry it
    expect(call({ direct: true, tool: 'COMPOSIO_SEARCH_TOOLS' })).toMatchObject({ directCalls: 0, listMicros: 0 });
    expect(call({ direct: true, tool: 'COMPOSIO_REMOTE_BASH_TOOL' })).toMatchObject({ directCalls: 0, listMicros: 100 });
    expect(call({ direct: true, tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: 'NOTION_A' }] } })).toMatchObject({ directCalls: 0, listMicros: 500 });
  });

  it('prices a batch as the tools inside it, with searches free and a sandbox run at the add-on, and keeps only their names', () => {
    const batch = call({
      tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      arguments: { tools: [{ tool_slug: 'NOTION_A', arguments: { secret: 'x' } }, { tool_slug: 'NOTION_A', arguments: {} }, { tool_slug: 'COMPOSIO_SEARCH_TOOLS' }, { tool_slug: 'COMPOSIO_REMOTE_WORKBENCH' }] },
    });
    expect(batch).toMatchObject({ kind: 'batch', executions: 2, sandboxRuns: 1, listMicros: 2 * 500 + 100 });
    expect(batch.inner).toEqual({ NOTION_A: 2, COMPOSIO_SEARCH_TOOLS: 1, COMPOSIO_REMOTE_WORKBENCH: 1 });
    expect(JSON.stringify(batch)).not.toContain('secret');
  });

  it('counts a batch whose list cannot be read as one tool run (an unknown price is never zero), and caps one at 50', () => {
    expect(call({ tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: 'nope' })).toMatchObject({ executions: 1, listMicros: 500, inner: { unknown: 1 } });
    const big = call({ tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: Array.from({ length: 80 }, () => ({ tool_slug: 'NOTION_A' })) } });
    expect(big.executions).toBe(50);
  });
});

const event = (over: Partial<ScannedEvent> = {}): ScannedEvent => ({
  occurredAt: new Date('2026-11-05T10:00:00Z'),
  costMicros: 500,
  tool: 'NOTION_A',
  toolkit: 'notion',
  executions: 1,
  sandboxRuns: 0,
  zdrCalls: 0,
  directCalls: 0,
  tier: 'managed_other',
  tierVerified: true,
  inner: {},
  legacy: false,
  ...over,
});
const many = (n: number, over: Partial<ScannedEvent> = {}) => Array.from({ length: n }, () => event(over));

describe('the month’s bill', () => {
  it('is the plan’s fee alone while the free calls cover everything, and the unused credit is lost', () => {
    const bill = billFrom(many(1000), COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill).toMatchObject({ executions: 1000, freeExecutions: 1000, paidExecutions: 0, usageMicros: 0, creditUsedMicros: 0, extraMicros: 0, planFeeMicros: 29_000_000, billedMicros: 29_000_000 });
    // What the meter wrote (list price) is more than what is billed: that is the point of this view
    expect(bill.recordedMicros).toBe(1000 * 500);
  });

  it('takes the free 20,000 managed calls off first, then the rest at their rate, inside the credit', () => {
    const bill = billFrom([event({ executions: 30_000 })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill).toMatchObject({ freeExecutions: 20_000, paidExecutions: 10_000, usageMicros: 10_000 * 500, creditUsedMicros: 5_000_000, extraMicros: 0, billedMicros: 29_000_000 });
  });

  it('bills past the credit', () => {
    // 20,000 free, then 100,000 at $0.002 = $200: the credit takes $29 off
    const bill = billFrom([event({ executions: 120_000, tier: 'managed_listed' })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill.usageMicros).toBe(100_000 * 2000);
    expect(bill).toMatchObject({ creditUsedMicros: PRO_PLAN_CREDIT_MICROS, extraMicros: 200_000_000 - PRO_PLAN_CREDIT_MICROS, billedMicros: 29_000_000 + 200_000_000 - PRO_PLAN_CREDIT_MICROS });
  });

  it('lets calls on our own sign-in use the 100,000 in all, beyond the 20,000 on Composio’s', () => {
    const bill = billFrom([event({ executions: 20_000 }), event({ executions: 80_000, tier: 'own' }), event({ executions: 10, tier: 'own' })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill).toMatchObject({ freeExecutions: 100_000, paidExecutions: 10, usageMicros: 10 * 300, managedExecutions: 20_000, ownExecutions: 80_010 });
  });

  it('counts the add-ons on every call they cover, free ones included, and a free lookup as no tool run', () => {
    const bill = billFrom([event({ tier: 'own', zdrCalls: 1, directCalls: 1 }), event({ executions: 0, sandboxRuns: 1, costMicros: 100 }), event({ executions: 0, costMicros: 0, tool: 'COMPOSIO_SEARCH_TOOLS' })], { plan: 'pro', zdrOn: true }, '2026-11');
    expect(bill).toMatchObject({ executions: 1, freeLookups: 1, sandboxRuns: 1, zdrCalls: 1, directCalls: 1, usageMicros: 100 + 100 + 100 });
  });

  it('counts the calls priced at a figure the rate card leaves open (Google Maps), and an event from before the meter priced by app as one run', () => {
    const bill = billFrom([event({ tier: 'managed_maps', tierVerified: false, executions: 3 }), event({ legacy: true })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill).toMatchObject({ unsettledPriceExecutions: 3, legacyEvents: 1 });
  });

  it('on Hobby has no fee and no credit, and says how many calls Composio would refuse', () => {
    const bill = billFrom([event({ executions: 25_000 })], { plan: 'hobby', zdrOn: false }, '2026-11');
    expect(bill).toMatchObject({ planFeeMicros: 0, creditUsedMicros: 0, billedMicros: 0, stoppedExecutions: 5_000 });
  });

  it('reads a month name, and refuses anything else', () => {
    expect(readMonth('2026-11')).toMatchObject({ key: '2026-11', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') });
    for (const bad of ['2026-13', '2026-1', 'nov', '', null, 5]) expect(readMonth(bad)).toBeNull();
  });
});

describe('reading a stored event', () => {
  const row = (detail: Record<string, unknown>) => readEvent({ occurredAt: new Date('2026-11-05T10:00:00Z'), costMicros: BigInt(500), detail });

  it('reads whether a price is settled from the event’s tier, not from the flag it was written with, so a month spanning a change counts by today’s rule', () => {
    const old = { toolkit: 'googlemaps', tool: 'GOOGLEMAPS_TEXT_SEARCH', executions: 3, sandboxRuns: 0, zdrCalls: 0, tier: 'managed_maps', tierVerified: true };
    expect(row(old)).toMatchObject({ executions: 3, tier: 'managed_maps', tierVerified: false, directCalls: 0, legacy: false });
    expect(row({ ...old, toolkit: 'gmail', tier: 'managed_listed', tierVerified: false })).toMatchObject({ tierVerified: true });
    expect(row({ ...old, tier: 'own', tierVerified: false })).toMatchObject({ tierVerified: true });
    expect(billFrom([row(old)], COMPOSIO_BILLING_DEFAULTS, '2026-11').unsettledPriceExecutions).toBe(3);
  });
});

describe('when a gap is worth a look', () => {
  it('flags calls only past the share and the floor', () => {
    expect(callGapIsFlagged(GAP_CALLS_MIN, 100)).toBe(false);
    expect(callGapIsFlagged(GAP_CALLS_MIN + 1, 100)).toBe(true);
    expect(callGapIsFlagged(1_000, 10_000)).toBe(false);
    expect(callGapIsFlagged(1_001, 10_000)).toBe(true);
  });

  it('flags an invoice only past the share and the floor', () => {
    expect(invoiceGapIsFlagged(GAP_INVOICE_MIN_MICROS, 10_000_000)).toBe(false);
    expect(invoiceGapIsFlagged(GAP_INVOICE_MIN_MICROS + 1, 10_000_000)).toBe(true);
    expect(invoiceGapIsFlagged(3_000_000, 100_000_000)).toBe(false);
    expect(invoiceGapIsFlagged(10_000_001, 100_000_000)).toBe(true);
  });
});
