import type { Metadata } from 'next';
import { ReceiptCheck } from '@/components/page-payments-receipt';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Payment', robots: { index: false, follow: false }, referrer: 'no-referrer' };

/**
 * Where a guest's receipt link goes (game #2044): the recovery code is in the link's fragment, which a browser never sends to any server, so
 * only this page's own script reads it. It asks Orbit, which asks the payment service, and shows only what Orbit found.
 */
export default async function PaymentReceipt({ params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  return <ReceiptCheck artifactId={artifactId} />;
}
