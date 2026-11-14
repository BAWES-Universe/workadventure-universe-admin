'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The bridge between a page that takes payments and Universe (game #2044). The page is in a locked frame on another address and can
 * only post one kind of message: `{ universe: 'use-app', app, job }`, asking for the checkout its owner set up. Everything real is
 * decided here and on the server: only the frame this component watches is listened to, the amount and the service are the owner's
 * (the message carries neither), and the page hears back only a status, never an address, a key or an order.
 */

type Status = 'checking' | 'paid' | 'not_paid' | 'cant_confirm' | 'unavailable' | 'limit' | 'started';

const WORDS: Record<string, string> = {
  unavailable: 'Payments unavailable',
  limit: 'Too many tries for now. Try again in a little while.',
  not_paid: 'The payment did not go through',
  cant_confirm: 'We could not confirm the payment',
};

const POLL_MS = 3_000;
const POLL_FOR_MS = 20 * 60_000;

export function PagePaymentsBridge({ artifactId }: { artifactId: string }) {
  const [line, setLine] = useState<string | null>(null);
  const [resume, setResume] = useState<{ url: string; app: string } | null>(null);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tell = useCallback((status: Status) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-artifact-frame]');
    // Opaque origin of the locked frame: it can only be addressed with "*", which is why the message holds nothing but a status
    frame?.contentWindow?.postMessage({ universe: 'app-result', status }, '*');
  }, []);

  const watch = useCallback(
    (orderId: string) => {
      const until = Date.now() + POLL_FOR_MS;
      const poll = async () => {
        try {
          const response = await fetch(`/api/pay/${encodeURIComponent(artifactId)}?order=${encodeURIComponent(orderId)}`, { cache: 'no-store' });
          const body = response.ok ? ((await response.json()) as { status: Status }) : null;
          if (body && body.status !== 'checking') {
            busy.current = false;
            setResume(null);
            setLine(body.status === 'paid' ? null : WORDS[body.status] ?? null);
            tell(body.status);
            return;
          }
        } catch {
          // Try again on the next turn
        }
        if (Date.now() < until) timer.current = setTimeout(poll, POLL_MS);
        else {
          busy.current = false;
          tell('checking');
        }
      };
      timer.current = setTimeout(poll, POLL_MS);
    },
    [artifactId, tell],
  );

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-artifact-frame]');
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { universe?: unknown; app?: unknown } | null;
      if (!data || data.universe !== 'use-app' || typeof data.app !== 'string' || busy.current) return;
      busy.current = true;
      // Open the window now, in the tap's own moment, so a blocked pop-up is the only thing left that can go wrong
      const popup = window.open('about:blank', '_blank');
      if (popup) popup.opener = null;
      try {
        const response = await fetch(`/api/pay/${encodeURIComponent(artifactId)}`, { method: 'POST', cache: 'no-store' });
        const body = (await response.json().catch(() => null)) as { orderId?: string; checkoutUrl?: string; app?: string; code?: string } | null;
        if (!response.ok || !body?.orderId || !body.checkoutUrl) {
          popup?.close();
          busy.current = false;
          const status: Status = body?.code === 'limit' ? 'limit' : 'unavailable';
          setLine(WORDS[status]);
          tell(status);
          return;
        }
        setLine(null);
        if (popup) popup.location.href = body.checkoutUrl;
        else setResume({ url: body.checkoutUrl, app: body.app ?? 'the payment page' });
        tell('started');
        watch(body.orderId);
      } catch {
        popup?.close();
        busy.current = false;
        setLine(WORDS.unavailable);
        tell('unavailable');
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [artifactId, tell, watch]);

  if (!line && !resume) return null;
  return (
    <div role="status" data-testid="pagePayments" className="fixed bottom-[max(3.25rem,env(safe-area-inset-bottom))] left-1/2 z-10 grid -translate-x-1/2 gap-2 rounded-2xl border border-[#2a2638] bg-[#15121f] px-4 py-3 text-center text-[14px] text-[#f3f1fa] shadow-[0_8px_24px_rgba(0,0,0,.45)] [font-family:var(--font-inter),system-ui,sans-serif]">
      {line ? <p>{line}</p> : null}
      {resume ? (
        <a href={resume.url} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[#f3f1fa] px-4 py-2 font-semibold text-[#0A0814] no-underline">
          Continue to {resume.app}
        </a>
      ) : null}
    </div>
  );
}
