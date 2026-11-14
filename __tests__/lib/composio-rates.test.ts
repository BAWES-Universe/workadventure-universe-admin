import {
  FREE_MANAGED_CALLS_PER_MONTH,
  FREE_TOOL_CALLS_PER_MONTH,
  PRO_PLAN_CREDIT_MICROS,
  PRO_PLAN_FEE_MICROS,
  RATE_MICROS,
  SANDBOX_RUN_MICROS,
  ZDR_ADD_ON_MICROS,
  priceCall,
  tierOf,
} from '@/lib/composio-rates';
import {
  COMPOSIO_BILLING_DEFAULTS,
  GAP_CALLS_MIN,
  GAP_INVOICE_MIN_MICROS,
  billFrom,
  callGapIsFlagged,
  invoiceGapIsFlagged,
  readMonth,
  type ScannedEvent,
} from '@/lib/composio-billing';

const call = (over: Partial<Parameters<typeof priceCall>[0]> = {}) => priceCall({ toolkit: 'notion', tool: 'NOTION_SEARCH', ownAuth: false, zdrOn: false, ...over });

describe('the rate table', () => {
  it('has the provider’s published figures, in millionths of a dollar', () => {
    expect(RATE_MICROS).toEqual({ own: 300, managed_other: 500, managed_listed: 2000, managed_premium: 2000, managed_maps: 10000 });
    expect([ZDR_ADD_ON_MICROS, SANDBOX_RUN_MICROS]).toEqual([100, 100]);
    expect([FREE_TOOL_CALLS_PER_MONTH, FREE_MANAGED_CALLS_PER_MONTH, PRO_PLAN_FEE_MICROS, PRO_PLAN_CREDIT_MICROS]).toEqual([100_000, 20_000, 29_000_000, 29_000_000]);
  });

  it('puts an app the page does not name in "all other managed apps", and says when a price is one the page does not settle', () => {
    expect(tierOf('notion', false)).toEqual({ tier: 'managed_other', verified: true });
    expect(tierOf('salesforce', false)).toEqual({ tier: 'managed_premium', verified: true });
    expect(tierOf('googlemaps', false)).toEqual({ tier: 'managed_maps', verified: true });
    // Gmail and its group: priced at the higher figure, and said to be unverified
    expect(tierOf('gmail', false)).toEqual({ tier: 'managed_listed', verified: false });
    expect(tierOf('Slack', false)).toEqual({ tier: 'managed_listed', verified: false });
    // Our own sign-in or an API key, whichever app
    expect(tierOf('gmail', true)).toEqual({ tier: 'own', verified: true });
  });
});

describe('pricing one call', () => {
  it('counts a tool run once at its app’s rate', () => {
    expect(call({ tool: 'NOTION_SEARCH_NOTION_PAGE' })).toMatchObject({ kind: 'execution', executions: 1, sandboxRuns: 0, listMicros: 500, zdrCalls: 0 });
    expect(call({ toolkit: 'salesforce', tool: 'SALESFORCE_CREATE_LEAD' }).listMicros).toBe(2000);
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
    const bill = billFrom([event({ executions: 120_000, tier: 'managed_premium' })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill.usageMicros).toBe(100_000 * 2000);
    expect(bill).toMatchObject({ creditUsedMicros: PRO_PLAN_CREDIT_MICROS, extraMicros: 200_000_000 - PRO_PLAN_CREDIT_MICROS, billedMicros: 29_000_000 + 200_000_000 - PRO_PLAN_CREDIT_MICROS });
  });

  it('lets calls on our own sign-in use the 100,000 in all, beyond the 20,000 on Composio’s', () => {
    const bill = billFrom([event({ executions: 20_000 }), event({ executions: 80_000, tier: 'own' }), event({ executions: 10, tier: 'own' })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
    expect(bill).toMatchObject({ freeExecutions: 100_000, paidExecutions: 10, usageMicros: 10 * 300, managedExecutions: 20_000, ownExecutions: 80_010 });
  });

  it('counts the add-ons on every call they cover, free ones included, and a free lookup as no tool run', () => {
    const bill = billFrom([event({ tier: 'own', zdrCalls: 1 }), event({ executions: 0, sandboxRuns: 1, costMicros: 100 }), event({ executions: 0, costMicros: 0, tool: 'COMPOSIO_SEARCH_TOOLS' })], { plan: 'pro', zdrOn: true }, '2026-11');
    expect(bill).toMatchObject({ executions: 1, freeLookups: 1, sandboxRuns: 1, zdrCalls: 1, usageMicros: 100 + 100 });
  });

  it('counts the calls priced at a figure the page does not settle, and an event from before the meter priced by app as one run', () => {
    const bill = billFrom([event({ tier: 'managed_listed', tierVerified: false, executions: 3 }), event({ legacy: true })], COMPOSIO_BILLING_DEFAULTS, '2026-11');
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
