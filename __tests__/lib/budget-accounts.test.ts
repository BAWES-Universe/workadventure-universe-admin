/**
 * What the Budget page reads from each company (billing consensus, provider table of 18 Nov): each one answering fine, empty, with an error and with a
 * timeout, and an answer that is not known is never shown as zero.
 */
import { describe as suite, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/budget/provider-keys', () => ({ sonioxOrgKey: jest.fn() }));
jest.mock('@/lib/app-adapter', () => ({ getAdapter: jest.fn() }));
jest.mock('@/lib/composio-billing', () => ({ readComposioBilling: jest.fn() }));

import { COMPANIES, describe as wordReading, readAgent37, readDeepSeek, readElevenLabs, readSoniox, Unreadable, type FetchLike } from '@/lib/budget/accounts';
import { requestTopUpLink } from '@/lib/budget/agent37-funds';

const answer = (body: unknown, status = 200): FetchLike => async () => ({ ok: status < 400, status, json: async () => body });
const now = new Date('2026-11-18T09:00:00Z');
const monthEnd = new Date('2026-12-01T00:00:00Z');
const company = (key: string) => COMPANIES.find((entry) => entry.key === key)!;

suite('Soniox', () => {
  const fine = { available_balance_usd: '42.50', free_balance_usd: '5.00', used_balance_usd: '10.00', invoice_billing_enabled: false, balance_exhausted: false, autopay_enabled: true, autopay_threshold_usd: '10', autopay_amount_usd: '25', has_payment_method: true, has_payment_error: false };

  it('reads the balance, the granted part and the autopay rule', async () => {
    const reading = await readSoniox('snx_org_x', answer(fine));
    expect(reading).toMatchObject({ kind: 'balance', balanceMicros: 42_500_000, empty: false, overdue: false });
    expect(reading.facts).toEqual(['$5 of it was granted', 'Autopay is on: adds $25 when under $10']);
  });

  it('says empty when the balance is exhausted, never a made-up number', async () => {
    const reading = await readSoniox('snx_org_x', answer({ ...fine, available_balance_usd: '0', balance_exhausted: true }));
    expect(reading.empty).toBe(true);
    expect(wordReading(company('soniox'), reading, now, monthEnd).state).toBe('zero');
  });

  it('is billed after use under invoice billing, with no balance', async () => {
    const reading = await readSoniox('snx_org_x', answer({ ...fine, invoice_billing_enabled: true }));
    expect(reading.kind).toBe('after');
    expect(wordReading(company('soniox'), reading, now, monthEnd)).toMatchObject({ kind: 'after', balanceMicros: null, state: 'ok' });
  });

  it('shows a failed payment as a warning even with money in the account', async () => {
    const reading = await readSoniox('snx_org_x', answer({ ...fine, has_payment_error: true }));
    expect(reading.overdue).toBe(true);
    expect(reading.facts).toContain('The last payment failed');
    expect(wordReading(company('soniox'), reading, now, monthEnd).state).toBe('low');
  });

  it('is unreadable, not zero, when the key is refused, rate limited or gives no balance', async () => {
    await expect(readSoniox('snx_org_x', answer(null, 401))).rejects.toThrow('refused the organization key');
    await expect(readSoniox('snx_org_x', answer(null, 429))).rejects.toThrow(Unreadable);
    await expect(readSoniox('snx_org_x', answer({ invoice_billing_enabled: false }))).rejects.toThrow('did not give a balance');
  });

  it('lets a timeout through as a failure, never as a reading', async () => {
    const slow: FetchLike = async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    };
    await expect(readSoniox('snx_org_x', slow)).rejects.toThrow();
  });

  it('says "not connected" in words, and never as an empty account', () => {
    const reading = { kind: 'unknown' as const, connected: false, note: 'Not connected. Soniox gives its balance only to an organization key: add one here and this row shows it.' };
    const view = wordReading(company('soniox'), reading, now, monthEnd);
    expect(view.state).toBe('unknown');
    expect(view.balanceMicros).toBeNull();
    expect(view.line).toContain('Not connected');
  });
});

suite('Agent37', () => {
  const wallet = { balance_usd: 42.5, tier: 1, instance_limit: 10, auto_top_up: { enabled: true, threshold_usd: 12.5, amount_usd: 25 }, past_due: false };
  const client = (value: unknown) => ({ billing: async () => value as never });

  it('reads the wallet with its tier and auto top up rule', async () => {
    const reading = await readAgent37(client(wallet));
    expect(reading).toMatchObject({ kind: 'balance', balanceMicros: 42_500_000, empty: false, overdue: false });
    expect(reading.facts).toEqual(['Tier 1, up to 10 computers', 'Auto top up is on: adds $25 when under $12.50']);
  });

  it('says auto top up is off when no rule is armed', async () => {
    const reading = await readAgent37(client({ ...wallet, auto_top_up: null }));
    expect(reading.facts?.[1]).toContain('Auto top up is off');
  });

  it('shows an overdue wallet as empty and red, with what Agent37 does about it', async () => {
    const reading = await readAgent37(client({ ...wallet, balance_usd: -3, past_due: true }));
    expect(reading).toMatchObject({ empty: true, overdue: true });
    expect(reading.facts?.join(' ')).toContain('puts computers to sleep');
    expect(wordReading(company('agent37'), reading, now, monthEnd).state).toBe('zero');
  });
});

suite('ElevenLabs and DeepSeek', () => {
  it('shows ElevenLabs credits, status and the invoice, and says what its API does not give', async () => {
    const reading = await readElevenLabs(
      'key',
      answer({ character_count: 20_000, character_limit: 100_000, next_character_count_reset_unix: Math.floor(now.getTime() / 1000) + 10 * 86_400, tier: 'creator', status: 'past_due', allowed_to_extend_character_limit: true, next_invoice: { amount_due_cents: 2200 }, open_invoices: [{}] }),
      now,
    );
    expect(reading).toMatchObject({ kind: 'plan', planLeftPercent: 80, overdue: true });
    expect(reading.facts).toEqual(expect.arrayContaining(['20,000 of 100,000 credits used this period', 'Plan: creator', 'Status: past due', 'Next invoice $22', '1 open invoice to pay']));
    expect(reading.facts?.[reading.facts.length - 1]).toContain('does not give the prepaid dollar balance');
  });

  it('is unreadable when ElevenLabs gives no limit, never a full plan', async () => {
    await expect(readElevenLabs('key', answer({ character_count: 1 }), now)).rejects.toThrow('did not give what its plan includes');
  });

  it('shows what DeepSeek granted and what was topped up', async () => {
    const reading = await readDeepSeek('key', answer({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '84.20', granted_balance: '4.20', topped_up_balance: '80.00' }] }));
    expect(reading).toMatchObject({ balanceMicros: 84_200_000, empty: false });
    expect(reading.facts?.slice(0, 2)).toEqual(['$4.20 of it was granted', '$80 of it was topped up']);
  });

  it('does not turn a balance in another currency into dollars', async () => {
    await expect(readDeepSeek('key', answer({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100' }] }))).rejects.toThrow('did not give a balance in dollars');
  });
});

suite('a payment link at Agent37', () => {
  const reply = (status: number, body: unknown) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  it('hands back the https link Agent37 made, with the amount asked for', async () => {
    const calls: unknown[] = [];
    const result = await requestTopUpLink('k', 25, async (url, init) => {
      calls.push([url, init?.body]);
      return { ok: true, status: 201, text: async () => JSON.stringify({ url: 'https://checkout.example.test/pay/abc', amount_usd: 25, paid: false }) };
    });
    expect(result).toEqual({ ok: true, url: 'https://checkout.example.test/pay/abc', amountUsd: 25 });
    expect(calls).toEqual([['https://api.agent37.com/v1/billing/top-up', JSON.stringify({ amount_usd: 25 })]]);
  });

  it('passes on Agent37’s own words when it refuses the amount, and charges nothing', async () => {
    const result = await requestTopUpLink('k', 1, reply(400, { error: { message: 'amount_usd is below the lowest top up' } }));
    expect(result).toEqual({ ok: false, status: 422, error: 'Agent37 said: amount_usd is below the lowest top up' });
  });

  it('refuses a link that is not https, an empty amount and an unreachable Agent37', async () => {
    expect(await requestTopUpLink('k', 25, reply(201, { url: 'http://insecure.example.test' }))).toMatchObject({ ok: false, status: 502 });
    expect(await requestTopUpLink('k', 0, reply(201, {}))).toMatchObject({ ok: false, status: 400 });
    expect(
      await requestTopUpLink('k', 25, async () => {
        throw new Error('network');
      }),
    ).toMatchObject({ ok: false, status: 502 });
  });
});
