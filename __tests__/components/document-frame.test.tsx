/** @jest-environment jsdom */

import { act, render } from '@testing-library/react';
import { DocumentFrame, MAX_PAPER_HEIGHTS } from '@/components/document-frame';
import { HEIGHT_SCRIPT } from '@/lib/artifact-public';

/** The frame's window, as the page sees it: it can be sent messages and says what it was sent. */
function frameWindow(container: HTMLElement) {
  const iframe = container.querySelector('iframe[data-document-frame]') as HTMLIFrameElement;
  const sent: unknown[] = [];
  const fake = { postMessage: (message: unknown) => sent.push(message) } as unknown as Window;
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => fake });
  return { iframe, fake, sent };
}

const say = (source: Window | null, data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  });

describe('DocumentFrame', () => {
  it('takes every width the frame measures: the script never lists more widths than the page accepts', () => {
    const widths = (/var W=\[([\d,]+)\]/.exec(HEIGHT_SCRIPT)?.[1] ?? '').split(',').filter(Boolean);
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.length).toBeLessThanOrEqual(MAX_PAPER_HEIGHTS);
    // And the page really accepts a full list
    const { container } = render(<DocumentFrame title="T" html="<p>x</p>" className="c" />);
    const { fake } = frameWindow(container);
    say(fake, { artifactPrintHeights: widths.map((w) => [Number(w), 1000]) });
    expect(container.querySelectorAll('style')).toHaveLength(1);
  });

  it('asks the frame for its heights once it listens and again when the frame has loaded', () => {
    const { container } = render(<DocumentFrame title="T" html="<p>x</p>" className="c" />);
    const { iframe, sent } = frameWindow(container);
    // The page's own request on loading (the frame's window did not exist yet when it listened, so it was a no-op)
    act(() => {
      iframe.dispatchEvent(new Event('load'));
    });
    expect(sent).toEqual(['artifact-heights']);
  });

  it('sizes the printed frame for each page width, never shorter than the height measured at its own width', () => {
    const { container } = render(<DocumentFrame title="T" html="<p>x</p>" className="c" />);
    const { fake, iframe } = frameWindow(container);
    say(fake, {
      artifactHeight: 900,
      artifactPrintHeights: [
        [840, 3000],
        [360, 6000],
        [600, 4000],
      ],
    });
    const id = iframe.getAttribute('data-document-frame');
    const css = container.querySelector('style')?.textContent ?? '';
    // Narrowest first, each wider step only from its own width, and every height has a little room
    expect(css).toContain(`[data-document-frame="${id}"] { height: ${Math.ceil(6000 * 1.03) + 32}px !important; }`);
    expect(css).toMatch(/@media \(min-width: 600px\) \{[^}]*height: 4152px !important/);
    expect(css.indexOf('min-width: 600px')).toBeLessThan(css.indexOf('min-width: 840px'));
    expect(css.startsWith('@media print {')).toBe(true);
    expect(iframe.style.getPropertyValue('--document-height')).toBe('900px');
  });

  it('ignores anything that is not plain numbers, and anything not from its own frame', () => {
    const { container } = render(<DocumentFrame title="T" html="<p>x</p>" className="c" />);
    const { fake } = frameWindow(container);
    say(fake, { artifactPrintHeights: [[360, '6000px; } body { display:none']] });
    say(fake, { artifactPrintHeights: [[360, -5]] });
    say(fake, { artifactPrintHeights: 'x' });
    say({} as Window, { artifactPrintHeights: [[360, 6000]] });
    expect(container.querySelector('style')).toBeNull();
  });
});
