import type { Metadata } from 'next';
import { verifyOrder, type OrderState } from '@/lib/app-direct/pay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = { title: 'Payment', robots: { index: false, follow: false }, referrer: 'no-referrer' };

const WORDS: Record<OrderState, { title: string; body: string }> = {
  paid: { title: 'Payment received', body: 'Thank you. You can close this window and go back to the page.' },
  checking: { title: 'Checking your payment', body: 'This usually takes a few seconds. This page will update by itself.' },
  not_paid: { title: 'Payment did not go through', body: 'Nothing was taken. You can close this window and try again from the page.' },
  cant_confirm: { title: 'We could not confirm this payment', body: 'If money left your account, contact the page’s owner with the time of the payment.' },
};

/**
 * Where the payment service sends the buyer after paying (game #2044). It shows only what Orbit itself found out from the service: never
 * what the address says, so a made-up one can say nothing is paid or paid. The page behind it hears the same through its own check.
 */
export default async function PaymentDone({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const { o } = await searchParams;
  const view = o && /^[0-9a-f-]{36}$/i.test(o) ? await verifyOrder(o).catch(() => null) : null;
  const words = view ? WORDS[view.status] : { title: 'This payment is not available', body: 'It may have been closed.' };
  return (
    <main className="grid min-h-dvh place-content-center gap-2 bg-[#0A0814] px-6 text-center text-[#f3f1fa] [font-family:var(--font-inter),system-ui,sans-serif]" role="status" data-testid="paymentDone">
      {view?.status === 'checking' ? <meta httpEquiv="refresh" content="4" /> : null}
      <h1 className="text-[22px] font-bold [font-family:var(--font-space-grotesk),system-ui,sans-serif]">{view?.testPayment && view.status === 'paid' ? 'Test payment received' : words.title}</h1>
      <p className="text-[15px] text-[#b3acc7]">{words.body}</p>
    </main>
  );
}
