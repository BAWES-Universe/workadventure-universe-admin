'use client';

import { useEffect, useId, useRef, useState } from 'react';

/** One measure of the document as paper: how tall it is when the page is this wide (in CSS pixels). */
type PaperHeight = readonly [width: number, height: number];

/** The most width and height pairs the page takes from the frame. The frame's script measures every width it lists, so a test checks the list is never longer than this. */
export const MAX_PAPER_HEIGHTS = 8;

/** A plain number from the frame, and nothing else. */
const plain = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1_000_000 ? Math.ceil(value) : null;

/** The paper heights the frame reported, if it reported a few sensible pairs, widest last. */
function paperHeightsOf(value: unknown): PaperHeight[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PAPER_HEIGHTS) return null;
  const heights: PaperHeight[] = [];
  for (const pair of value as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const width = plain(pair[0]);
    const height = plain(pair[1]);
    if (width === null || height === null) return null;
    heights.push([width, height]);
  }
  return heights.sort((a, b) => a[0] - b[0]);
}

/**
 * The print styles for one frame: its height on paper at the width the frame itself prints at. A narrower frame wraps the
 * text onto more lines, so each step of width has the height measured at that step's own width, and the frame takes the
 * step it is at or above (never a shorter one). The width is the frame's own box (the box around it is the container the
 * steps ask), not the page's, so a frame inside padding or a border is measured at what it really gets. The first rule is
 * the tallest, so a browser that does not know container queries still prints all of it. Written as one stylesheet because
 * a frame's height can only be set from the page.
 */
function printStyles(id: string, heights: PaperHeight[]): string {
  const selector = `[data-document-frame="${id}"]`;
  const tall = (height: number) => `height: ${Math.ceil(height * 1.03) + 32}px !important;`;
  const steps = heights.map(([width, height], index) =>
    index === 0 ? `${selector} { ${tall(height)} }` : `@container (min-width: ${width}px) { ${selector} { ${tall(height)} } }`
  );
  return `@media print { ${steps.join(' ')} }`;
}

/**
 * A document in its locked frame. The frame has no origin of its own and no permission but the one script its policy names
 * (see `markdownDocument`), which only reports how tall the document is, on screen and as it will be on paper. The paper
 * height is used when the page is printed, so the whole document prints, over as many pages as it takes, and not only what
 * the window showed. Anything else a frame says is ignored: only plain numbers from this frame count.
 */
export function DocumentFrame({ title, html, className }: { title: string; html: string; className: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const id = useId();
  const [height, setHeight] = useState<number | null>(null);
  const [paper, setPaper] = useState<PaperHeight[] | null>(null);

  const ask = () => frame.current?.contentWindow?.postMessage('artifact-heights', '*');

  useEffect(() => {
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { artifactHeight?: unknown; artifactPrintHeights?: unknown } | null;
      const screen = plain(data?.artifactHeight);
      const sheets = paperHeightsOf(data?.artifactPrintHeights);
      if (screen) setHeight(screen);
      if (sheets) setPaper(sheets);
    };
    window.addEventListener('message', heard);
    // The frame may have reported before this page listened (it can load first): ask again now that it does
    ask();
    return () => window.removeEventListener('message', heard);
  }, []);

  return (
    <>
      {paper ? <style>{printStyles(id, paper)}</style> : null}
      {/* The box the print steps ask for the frame's width: it is as wide as the frame and nothing else */}
      <div style={{ containerType: 'inline-size', width: '100%', height: '100%' }}>
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={html}
          referrerPolicy="no-referrer"
          data-document-frame={id}
          onLoad={ask}
          style={height ? { ['--document-height' as string]: `${height}px` } : undefined}
          className={`${className} print:h-[var(--document-height,100dvh)] print:min-h-0`}
        />
      </div>
    </>
  );
}
