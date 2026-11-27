'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * A document in its locked frame. The frame has no origin of its own and no permission but the one script its policy names
 * (see `markdownDocument`), which only reports how tall the document is. The height is used when the page is printed, so
 * the whole document prints, over as many pages as it takes, and not only what the window showed. Anything else a frame
 * says is ignored: only a plain number from this frame counts.
 */
export function DocumentFrame({ title, html, className }: { title: string; html: string; className: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const said = (event.data as { artifactHeight?: unknown } | null)?.artifactHeight;
      if (typeof said === 'number' && Number.isFinite(said) && said > 0 && said < 1_000_000) setHeight(Math.ceil(said));
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
      style={height ? ({ '--document-height': `${height}px` } as CSSProperties) : undefined}
      className={`${className} print:h-[var(--document-height,100dvh)] print:min-h-0`}
    />
  );
}
