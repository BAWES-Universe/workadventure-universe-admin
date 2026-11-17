import { AGENT37_API } from '@/lib/agent37/client';

/**
 * "Add funds" at Agent37: asks Agent37 for a hosted payment link for an amount a super admin typed (`POST /v1/billing/top-up`). Nothing is paid from
 * here: the link is the person's own checkout, and the funds arrive only once Agent37 confirms the payment. The amount's lowest and highest are
 * Agent37's own to say: when it refuses an amount, its words are passed on.
 */
export type TopUpResult = { ok: true; url: string; amountUsd: number } | { ok: false; status: number; error: string };

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export async function requestTopUpLink(key: string, amountUsd: number, fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<TopUpResult> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return { ok: false, status: 400, error: 'Type the amount to add, in dollars.' };
  let response: Awaited<ReturnType<Fetch>>;
  try {
    response = await fetchImpl(`${AGENT37_API}/v1/billing/top-up`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_usd: amountUsd }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: 'Agent37 could not be reached. Nothing was charged.' };
  }
  const text = await response.text().catch(() => '');
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = typeof json?.message === 'string' ? json.message : typeof (json?.error as Record<string, unknown> | undefined)?.message === 'string' ? ((json!.error as Record<string, unknown>).message as string) : typeof json?.error === 'string' ? json.error : null;
    if (response.status === 401 || response.status === 403) return { ok: false, status: 502, error: 'Agent37 refused Orbit’s key. Nothing was charged.' };
    return { ok: false, status: response.status === 429 ? 429 : 422, error: message ? `Agent37 said: ${message}` : 'Agent37 would not make a payment link for that amount. Nothing was charged.' };
  }
  const url = typeof json?.url === 'string' ? json.url : null;
  // Only a link on https is ever handed to the page
  if (!url || !/^https:\/\//.test(url)) return { ok: false, status: 502, error: 'Agent37 did not give a payment link. Nothing was charged.' };
  return { ok: true, url, amountUsd };
}
