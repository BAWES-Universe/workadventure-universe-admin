'use client';

import { useEffect, useRef, useState } from 'react';
import { createPagePaymentsHost, NO_PAY_LINE, type PagePaymentsHost, type PayLine } from '@/lib/page-payments-host';
import { PAY_WORDS } from '@/components/page-payments-words';

/**
 * The bridge between a page that takes payments and Universe, on the public share link (game #2044). All of what it does with the page lives
 * in `lib/page-payments-host.ts` (the same protocol as the game's window: a request id on every message and every answer, busy per request,
 * never a bare "paid"); this only draws the line under the page. The words are in `page-payments-words.ts`.
 */
export function PagePaymentsBridge({ artifactId }: { artifactId: string }) {
  const [line, setLine] = useState<PayLine>(NO_PAY_LINE);
  const [copied, setCopied] = useState(false);
  const host = useRef<PagePaymentsHost | null>(null);

  useEffect(() => {
    const frame = () => document.querySelector<HTMLIFrameElement>('iframe[data-artifact-frame]');
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const made = createPagePaymentsHost({
      artifactId,
      frame: () => frame()?.contentWindow,
      openWindow: () => window.open('about:blank', '_blank'),
      storage,
      origin: window.location.origin,
    });
    host.current = made;
    const unsubscribe = made.subscribe(setLine);
    const onMessage = (event: MessageEvent) => made.onMessage(event);
    window.addEventListener('message', onMessage);
    // A reload or another version of the page is another opening: what an earlier one asked is never told to it
    const element = frame();
    const onLoad = () => made.frameLoaded();
    element?.addEventListener('load', onLoad);
    return () => {
      window.removeEventListener('message', onMessage);
      element?.removeEventListener('load', onLoad);
      unsubscribe();
      made.destroy();
      host.current = null;
      setLine(NO_PAY_LINE);
    };
  }, [artifactId]);

  const text = line.paid ? (line.paid.test ? PAY_WORDS.paidTest : PAY_WORDS.paid) : line.problem ? PAY_WORDS.problem[line.problem] : line.slow ? PAY_WORDS.slow : line.checking ? PAY_WORDS.checking : null;
  if (!text && !line.resume && !line.needsUpdate && !line.canCheck && !line.receipt) return null;
  return (
    <div role="status" data-testid="pagePayments" className="fixed bottom-[max(3.25rem,env(safe-area-inset-bottom))] left-1/2 z-10 grid -translate-x-1/2 gap-2 rounded-2xl border border-[#2a2638] bg-[#15121f] px-4 py-3 text-center text-[14px] text-[#f3f1fa] shadow-[0_8px_24px_rgba(0,0,0,.45)] [font-family:var(--font-inter),system-ui,sans-serif]">
      {text ? <p>{text}</p> : null}
      {line.needsUpdate ? <p>{PAY_WORDS.needsUpdate}</p> : null}
      {line.resume ? (
        <a href={line.resume.url} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[#f3f1fa] px-4 py-2 font-semibold text-[#0A0814] no-underline">
          {PAY_WORDS.resume(line.resume.app)}
        </a>
      ) : null}
      {line.canCheck && !line.checking ? (
        <button type="button" onClick={() => host.current?.checkPayment()} className="rounded-full bg-[#f3f1fa] px-4 py-2 font-semibold text-[#0A0814]">
          {PAY_WORDS.checkPayment}
        </button>
      ) : null}
      {line.receipt ? (
        <button
          type="button"
          onClick={() => {
            // The link holds the recovery code in its fragment: it goes to the clipboard, and nowhere else
            void navigator.clipboard?.writeText(line.receipt as string).then(() => setCopied(true), () => setCopied(false));
          }}
          className="rounded-full border border-[#2a2638] px-4 py-2 font-semibold text-[#f3f1fa]"
        >
          {copied ? PAY_WORDS.receiptCopied : PAY_WORDS.saveReceipt}
        </button>
      ) : null}
    </div>
  );
}
