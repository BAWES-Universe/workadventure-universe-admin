'use client';

import { useEffect, useRef, useState } from 'react';
import { createPagePaymentsHost, NO_PAY_LINE, type PagePaymentsHost, type PayLine } from '@/lib/page-payments-host';
import { describeLine, PAY_WORDS, type PayAction } from '@/components/page-payments-words';

/**
 * The bridge between a page that takes payments and Universe, on the public share link (game #2044). All of what it does with the page lives
 * in `lib/page-payments-host.ts` (the same protocol as the game's window: a request id on every message and every answer, busy per request,
 * never a bare "paid"); this only draws the line under the page, as mock M1 shows it. The words are in `page-payments-words.ts`.
 *
 * A guest's receipt link is this page's own address with `#receipt=<code>`: the code is adopted from the address when the page opens and then
 * taken out of it, so it is never in the history or sent to a server.
 */
export function PagePaymentsBridge({ artifactId, version }: { artifactId: string; version?: number }) {
  const [line, setLine] = useState<PayLine>(NO_PAY_LINE);
  // The receipt link that was copied (or that could not be), never a bare yes: another page's receipt, or an earlier copy that finishes late, is never "copied"
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const host = useRef<PagePaymentsHost | null>(null);

  useEffect(() => {
    const frame = () => document.querySelector<HTMLIFrameElement>('iframe[data-artifact-frame]');
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    // This tab's own storage: only a code that nothing could coordinate lives there (it survives a reload of the tab, and is never shared with another)
    let tabStorage: Storage | null = null;
    try {
      tabStorage = window.sessionStorage;
    } catch {
      tabStorage = null;
    }
    const made = createPagePaymentsHost({
      artifactId,
      // The version on screen: a start is never charged with terms set on a newer one
      version,
      frame: () => frame()?.contentWindow,
      openWindow: () => window.open('about:blank', '_blank'),
      storage,
      tabStorage,
      pageUrl: `${window.location.origin}${window.location.pathname}${window.location.search}`,
    });
    host.current = made;
    // A receipt link brings its code here before the page can ask for its purchase
    const receipt = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('receipt');
    if (receipt) {
      made.useReceiptCode(receipt);
      try {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
      } catch {
        // The address stays as it is
      }
    }
    const unsubscribe = made.subscribe(setLine);
    const onMessage = (event: MessageEvent) => made.onMessage(event);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribe();
      made.destroy();
      host.current = null;
      setLine(NO_PAY_LINE);
    };
  }, [artifactId, version]);

  const view = describeLine(line, { copied: !!line.receipt && copied === line.receipt });
  // Only a line that offers the copy (a purchase made in this browser) can show the link a failed copy leaves to select: a purchase found through
  // someone's receipt link is "back", and this browser's own link would not bring it back
  const failed = !!line.receipt && copyFailed === line.receipt && !!view?.actions.some((action) => action.kind === 'copy');
  if (!view) return null;

  const press = (action: PayAction) => {
    if (action.kind === 'check') host.current?.checkPayment();
    else if (action.kind === 'restore') host.current?.restorePurchase();
    else if (action.kind === 'copy' && line.receipt) {
      // The link holds the recovery code in its fragment: it goes to the clipboard, and nowhere else
      const receipt = line.receipt;
      const fail = () => {
        setCopied((now) => (now === receipt ? null : now));
        setCopyFailed(receipt);
      };
      if (!navigator.clipboard?.writeText) return fail();
      void navigator.clipboard.writeText(receipt).then(
        () => {
          setCopyFailed(null);
          setCopied(receipt);
        },
        fail,
      );
    }
  };
  const button = 'inline-flex h-11 items-center justify-center gap-2 rounded-full px-[18px] text-[14px] font-bold text-white no-underline';
  const styleOf = (action: PayAction) =>
    action.style === 'primary'
      ? `${button} border-0 bg-[linear-gradient(90deg,#8629fc,#4156f6)] shadow-[0_8px_24px_-10px_rgba(134,41,252,.7)]`
      : `${button} border border-white/[.12] bg-white/[.06]`;

  return (
    <div
      role="status"
      data-testid="pagePayments"
      className={`fixed bottom-[max(3.25rem,env(safe-area-inset-bottom))] left-1/2 z-10 grid w-max max-w-[min(440px,calc(100%-24px))] -translate-x-1/2 gap-1.5 rounded-2xl border border-[#2a2638] bg-[#15121f] px-4 py-3.5 text-center text-[14px] text-[#f3f1fa] shadow-[0_8px_24px_rgba(0,0,0,.45)] [font-family:var(--font-inter),system-ui,sans-serif] ${view.closable ? 'pr-10' : ''}`}
    >
      {view.closable ? (
        <button type="button" aria-label="Close" onClick={() => host.current?.dismiss()} className="absolute right-1 top-1 grid size-8 place-items-center border-0 bg-transparent text-[18px] text-white/60">
          ×
        </button>
      ) : null}
      <p className="m-0 font-semibold">{view.title}</p>
      {view.sub ? <p className="m-0 text-[13px] leading-[1.4] text-[#b3acc7]">{view.sub}</p> : null}
      {view.note ? (
        <p className="m-0 text-[13px] leading-[1.4] text-[#b3acc7]" data-testid="pagePaymentsNote">
          {view.note}
        </p>
      ) : null}
      {failed && line.receipt ? (
        <>
          <p className="m-0 text-[13px] leading-[1.4] text-[#b3acc7]">{PAY_WORDS.copyFailed}</p>
          <input readOnly value={line.receipt} aria-label="Private receipt link" onFocus={(event) => event.currentTarget.select()} className="h-11 w-full min-w-0 rounded-full border border-white/[.12] bg-white/[.06] px-4 text-[13px] text-[#f3f1fa]" />
        </>
      ) : null}
      {view.actions.length ? (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {view.actions.map((action) =>
            action.kind === 'resume' ? (
              <a key={action.kind} href={action.url} target="_blank" rel="noopener noreferrer" className={styleOf(action)}>
                {action.label}
              </a>
            ) : (
              <button key={action.kind} type="button" disabled={action.kind === 'copy' && action.disabled} onClick={() => press(action)} className={styleOf(action)}>
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
