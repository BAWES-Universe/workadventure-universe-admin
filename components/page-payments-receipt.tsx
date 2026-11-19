'use client';

import { useEffect, useState } from 'react';
import { PAY_WORDS } from '@/components/page-payments-words';

type Found = { status: 'paid' | 'checking' | 'none'; testPayment?: boolean; pollAfterMs?: number };

/** What a guest's receipt link shows: whether the payment their browser (or this link) made for the page is paid. PLACEHOLDER wording, see page-payments-words.ts. */
export function ReceiptCheck({ artifactId }: { artifactId: string }) {
  const [found, setFound] = useState<Found | 'loading' | 'unavailable'>('loading');

  useEffect(() => {
    const code = window.location.hash.replace(/^#/, '');
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        const response = await fetch(`/api/pay/${encodeURIComponent(artifactId)}`, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restore: true, recoveryCode: code }) });
        const body = response.ok ? ((await response.json()) as Found) : null;
        if (stopped) return;
        if (!body) return setFound('unavailable');
        setFound(body);
        if (body.status === 'checking') timer = setTimeout(() => void look(), Math.min(30_000, Math.max(3_000, body.pollAfterMs ?? 5_000)));
      } catch {
        if (!stopped) setFound('unavailable');
      }
    };
    void look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [artifactId]);

  const text =
    found === 'loading' ? PAY_WORDS.checking : found === 'unavailable' ? PAY_WORDS.problem.unavailable : found.status === 'paid' ? (found.testPayment ? PAY_WORDS.paidTest : PAY_WORDS.paid) : found.status === 'checking' ? PAY_WORDS.checking : PAY_WORDS.problem.none;
  return (
    <main className="grid min-h-dvh place-content-center gap-2 bg-[#0A0814] px-6 text-center text-[#f3f1fa] [font-family:var(--font-inter),system-ui,sans-serif]" role="status" data-testid="paymentReceipt">
      <h1 className="text-[22px] font-bold [font-family:var(--font-space-grotesk),system-ui,sans-serif]">{text}</h1>
    </main>
  );
}
