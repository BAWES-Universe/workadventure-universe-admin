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
  // A closed checkout can still be paid for a while at the service: this never says that nothing was taken
  not_paid: 'We have not received this payment yet. If you already paid, it can take a little while to show.',
  cant_confirm: 'We could not confirm the payment',
};

const POLL_MS = 3_000;
const POLL_FOR_MS = 20 * 60_000;

export function PagePaymentsBridge({ artifactId }: { artifactId: string }) {
  const [line, setLine] = useState<string | null>(null);
  const [resume, setResume] = useState<{ url: string; app: string } | null>(null);
  /** An order that was not paid when the watch ended: it can be looked at again, because paying at the service late still counts. */
  const [recheck, setRecheck] = useState<string | null>(null);
  const busy = useRef(false);
  /** Which watch is current: an answer that comes back for an older page (or after cleanup) is dropped unread. */
  const current = useRef(0);
  /** The order the buyer is looking at now. Earlier orders keep being looked at, but only to hear that one of them was paid. */
  const primary = useRef<string | null>(null);
  const watchers = useRef(new Map<string, () => void>());
  /** Orders whose watch ran out while they were still unpaid: a payment at the service can still arrive for them, so they are looked at again with "Check again". */
  const expired = useRef(new Set<string>());

  const tell = useCallback((status: Status) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-artifact-frame]');
    // Opaque origin of the locked frame: it can only be addressed with "*", which is why the message holds nothing but a status
    frame?.contentWindow?.postMessage({ universe: 'app-result', status }, '*');
  }, []);

  /** Any order that ran out unpaid: what "Check again" is offered for when the order the buyer was on cannot be asked about again. */
  const firstExpired = useCallback((): string | null => Array.from(expired.current)[0] ?? null, []);

  const stopAll = useCallback(() => {
    watchers.current.forEach((stop) => stop());
    watchers.current.clear();
    expired.current.clear();
  }, []);

  const watch = useCallback(
    (orderId: string, asPrimary = true) => {
      watchers.current.get(orderId)?.();
      expired.current.delete(orderId);
      // A new checkout takes over the screen, but an earlier one is not dropped: a buyer who paid it late must still be heard
      if (asPrimary) primary.current = orderId;
      const page = current.current;
      const until = Date.now() + POLL_FOR_MS;
      let toldNotPaid = false;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
      watchers.current.set(orderId, stop);
      const alive = () => !stopped && page === current.current;
      const finish = () => {
        stop();
        if (watchers.current.get(orderId) === stop) watchers.current.delete(orderId);
      };
      const poll = async () => {
        if (!alive()) return;
        try {
          const response = await fetch(`/api/pay/${encodeURIComponent(artifactId)}?order=${encodeURIComponent(orderId)}`, { cache: 'no-store' });
          const body = response.ok ? ((await response.json()) as { status: Status }) : null;
          if (!alive()) return;
          if (body?.status === 'paid') {
            // Paid wins whichever order it is: everything else stops, and a checkout still on its way is dropped
            stopAll();
            primary.current = null;
            current.current += 1;
            busy.current = false;
            setResume(null);
            setRecheck(null);
            setLine(null);
            tell('paid');
            return;
          }
          const mine = primary.current === orderId;
          if (body?.status === 'cant_confirm') {
            finish();
            if (!mine) return;
            busy.current = false;
            setResume(null);
            // Older orders that ran out are still worth asking about
            setRecheck(firstExpired());
            setLine(WORDS.cant_confirm);
            tell('cant_confirm');
            return;
          }
          if (body?.status === 'not_paid' && mine && !toldNotPaid) {
            // Said once, and the order goes on being looked at until the time is up: a payment made at the service after the checkout closed still arrives
            toldNotPaid = true;
            busy.current = false;
            setResume(null);
            // Older orders that ran out while this checkout was being looked at can be asked about again now
            setRecheck((now) => now ?? firstExpired());
            setLine(WORDS.not_paid);
            tell('not_paid');
          }
        } catch {
          // Try again on the next turn
        }
        if (!alive()) return;
        if (Date.now() < until) {
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        finish();
        // The look ran out with the order unpaid: "Check again" can ask about it once more
        expired.current.add(orderId);
        // An older order's look ends without a word while the buyer is on a newer one; if there is none to be on (it ended, or never
        // started), the button is how the older one can be asked about again
        if (primary.current !== orderId) {
          if (!busy.current) setRecheck((now) => now ?? orderId);
          return;
        }
        if (toldNotPaid) {
          // The look ends here, and the buyer can ask for another one
          setRecheck(orderId);
        } else {
          // Twenty minutes without an answer: said plainly, never a silent end. The order may still be counted later.
          busy.current = false;
          setResume(null);
          setLine(WORDS.cant_confirm);
          setRecheck(orderId);
          tell('cant_confirm');
        }
      };
      timer = setTimeout(poll, POLL_MS);
    },
    [artifactId, tell, stopAll, firstExpired],
  );

  useEffect(() => {
    busy.current = false;
    const onMessage = async (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-artifact-frame]');
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { universe?: unknown; app?: unknown } | null;
      if (!data || data.universe !== 'use-app' || typeof data.app !== 'string' || busy.current) return;
      busy.current = true;
      setRecheck(null);
      // The earlier order stops being what the screen is about the moment a new checkout begins, not when its answer comes: from here it
      // can only report that it was paid
      const before = primary.current;
      primary.current = null;
      // A checkout that never started leaves the screen about the order it was about
      const restore = () => {
        if (primary.current === null) primary.current = before;
        // The button for orders that ran out, which this tap cleared, comes back
        setRecheck(firstExpired());
      };
      const generation = current.current;
      // Open the window now, in the tap's own moment, so a blocked pop-up is the only thing left that can go wrong
      const popup = window.open('about:blank', '_blank');
      if (popup) popup.opener = null;
      try {
        const response = await fetch(`/api/pay/${encodeURIComponent(artifactId)}`, { method: 'POST', cache: 'no-store' });
        const body = (await response.json().catch(() => null)) as { orderId?: string; checkoutUrl?: string; app?: string; code?: string } | null;
        // The page changed while this was on its way: its answer is not for the page that is here now
        if (generation !== current.current) {
          popup?.close();
          return;
        }
        if (!response.ok || !body?.orderId || !body.checkoutUrl) {
          popup?.close();
          busy.current = false;
          restore();
          const status: Status = body?.code === 'limit' ? 'limit' : 'unavailable';
          setLine(WORDS[status]);
          tell(status);
          return;
        }
        setLine(null);
        if (popup) popup.location.href = body.checkoutUrl;
        // The link stays whether or not the window opened: a buyer who closes it unpaid can open the same checkout again
        setResume({ url: body.checkoutUrl, app: body.app ?? 'the payment page' });
        tell('started');
        watch(body.orderId);
      } catch {
        popup?.close();
        if (generation !== current.current) return;
        busy.current = false;
        restore();
        setLine(WORDS.unavailable);
        tell('unavailable');
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      // Everything still in flight belongs to a page that is gone, and so do its line, its link and its busy tap
      current.current += 1;
      busy.current = false;
      primary.current = null;
      stopAll();
      setLine(null);
      setResume(null);
      setRecheck(null);
    };
  }, [artifactId, tell, watch, stopAll, firstExpired]);

  if (!line && !resume && !recheck) return null;
  return (
    <div role="status" data-testid="pagePayments" className="fixed bottom-[max(3.25rem,env(safe-area-inset-bottom))] left-1/2 z-10 grid -translate-x-1/2 gap-2 rounded-2xl border border-[#2a2638] bg-[#15121f] px-4 py-3 text-center text-[14px] text-[#f3f1fa] shadow-[0_8px_24px_rgba(0,0,0,.45)] [font-family:var(--font-inter),system-ui,sans-serif]">
      {line ? <p>{line}</p> : null}
      {resume ? (
        <a href={resume.url} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[#f3f1fa] px-4 py-2 font-semibold text-[#0A0814] no-underline">
          Open {resume.app} again
        </a>
      ) : null}
      {recheck ? (
        <button
          type="button"
          onClick={() => {
            setRecheck(null);
            setLine(null);
            // Every order that ran out is asked about again; the one the buyer was on stays the one the screen is about
            for (const older of Array.from(expired.current)) if (older !== recheck) watch(older, false);
            watch(recheck);
          }}
          className="rounded-full bg-[#f3f1fa] px-4 py-2 font-semibold text-[#0A0814]"
        >
          Check again
        </button>
      ) : null}
    </div>
  );
}
