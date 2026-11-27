'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * A document in its locked frame. The frame has no origin of its own and no permission but the one script its policy names
 * (see `markdownDocument`), which only reports how tall the document is, on screen and as it will be on paper. The paper
 * height is used when the page is printed, so the whole document prints, over as many pages as it takes, and not only what
 * the window showed. Anything else a frame says is ignored: only a plain number from this frame counts.
 */
export function DocumentFrame({ title, html, className }: { title: string; html: string; className: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [printHeight, setPrintHeight] = useState<number | null>(null);

  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { artifactHeight?: unknown; artifactPrintHeight?: unknown } | null;
      const plain = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1_000_000 ? Math.ceil(value) : null;
      const screen = plain(data?.artifactHeight);
      const paper = plain(data?.artifactPrintHeight);
      if (screen) setHeight(screen);
      if (paper) setPrintHeight(paper);
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, []);

  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      srcDoc={html}
      referrerPolicy="no-referrer"
      data-document-frame
      style={
        height || printHeight
          ? ({
              '--document-height': height ? `${height}px` : undefined,
              // The paper height has a little room added: a printer's fonts and margins are never exactly the measure's
              '--document-print-height': printHeight ? `${Math.ceil(printHeight * 1.05) + 48}px` : undefined,
            } as CSSProperties)
          : undefined
      }
      className={`${className} print:h-[var(--document-print-height,var(--document-height,100dvh))] print:min-h-0`}
    />
  );
}
