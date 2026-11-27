import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactBox, LinkNotAvailable, PublicArtifact } from '@/components/public-artifact';
import { createHash } from 'node:crypto';
import { HEIGHT_SCRIPT, HEIGHT_SCRIPT_HASH, markdownDocument } from '@/lib/artifact-public';
import type { PublicView } from '@/lib/artifact-service';

const UNIVERSE = 'https://play.example';
const app: PublicView = { title: 'Quests board', kind: 'app', makerName: 'Scout', version: 2, url: 'https://artifacts.example/a/v2.html', content: null };

describe('the public artifact page', () => {
  it('is just the artifact filling the window in a locked frame, with only the floating pill to Universe', () => {
    const html = renderToStaticMarkup(<PublicArtifact view={app} universeUrl={UNIVERSE} />);
    // A link in it opens in a new tab when tapped (a booking, a map), never in place of the game or this page
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).toContain('src="https://artifacts.example/a/v2.html"');
    expect(html).toContain('title="Quests board"');
    expect(html).toContain('Made with Universe');
    expect(html).toContain(`href="${UNIVERSE}"`);
    // Opens Universe in a new tab, so the artifact stays open
    expect(html).toContain('target="_blank"');
    // No header, box or footer: name, maker and version stay in the game's window
    expect(html).not.toContain('publicArtifactHeader');
    expect(html).not.toContain('By Scout');
    expect(html).not.toContain('Version 2');
    expect(html).not.toContain('<footer');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('min-h-[60dvh]');
    // View only: nothing to ask, change, restore or share
    expect(html).not.toMatch(/<button/i);
    expect(html).not.toContain('Ask');
    // Marks the page so the body behind the frame is ink too (globals.css): no light strip on phones
    expect(html).toContain('data-shared-page');
  });

  it('keeps the header and the locked box for the owner in Orbit', () => {
    const html = renderToStaticMarkup(<ArtifactBox view={app} />);
    expect(html).toContain('publicArtifactHeader');
    expect(html).toContain('By Scout · Version 2');
    expect(html).toContain('src="https://artifacts.example/a/v2.html"');
  });

  it('draws a document from its text in a frame with no origin of its own, opening links in a new tab', () => {
    const html = renderToStaticMarkup(<PublicArtifact view={{ ...app, kind: 'markdown', content: '# Notes\n\n<script>alert(1)</script>' }} universeUrl={UNIVERSE} />);
    // The one script a document carries only reports its height; the frame never shares the page's origin
    expect(html).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).toContain('srcDoc=');
    expect(html).not.toContain('src="https://artifacts.example');
  });

  it('lets a document run its one height script by hash and no script of its own', () => {
    expect(HEIGHT_SCRIPT_HASH).toBe(createHash('sha256').update(HEIGHT_SCRIPT).digest('base64'));
    const doc = markdownDocument('<script>alert(1)</script>\n\n# Hi');
    expect(doc).toContain(`script-src 'sha256-${HEIGHT_SCRIPT_HASH}'`);
    expect(doc).not.toContain("'unsafe-inline'; img-src https: data:; script-src 'unsafe");
    expect(doc).not.toMatch(/script-src[^"]*'unsafe-(inline|eval)'/);
    // The page's own script is the only one the policy names; the document's text sits after it, in the body
    expect(doc.indexOf(HEIGHT_SCRIPT)).toBeLessThan(doc.indexOf('alert(1)'));
    // The script says nothing but a height
    expect(HEIGHT_SCRIPT).toContain('artifactHeight');
    expect(HEIGHT_SCRIPT).toContain('artifactPrintHeights');
    expect(HEIGHT_SCRIPT).not.toMatch(/cookie|storage|fetch|XMLHttp|location/);
  });

  it('shows a tag written in a document as text, so a document can never send its frame to another address', () => {
    const doc = markdownDocument(
      [
        '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
        '',
        'A line with <meta http-equiv="refresh" content="0;url=https://evil.example/"> inside it, and <b onclick="x()">bold</b>.',
        '',
        '<iframe src="https://evil.example/"></iframe>',
        '<form action="https://evil.example/"><input name="a"></form>',
        '<script>parent.location = "https://evil.example/"</script>',
      ].join('\n')
    );
    // The only tags in the document are the page's own: one policy, one base, one height script
    const body = doc.slice(doc.indexOf('<body>'));
    expect(body).not.toMatch(/<(meta|iframe|form|input|script|b )/i);
    expect(doc.match(/<meta http-equiv=/g)).toHaveLength(1);
    expect(doc.match(/<script>/g)).toHaveLength(1);
    // What the writer wrote is still there to read
    expect(body).toContain('&lt;meta http-equiv=&quot;refresh&quot;');
    expect(body).toContain('&lt;iframe src=&quot;https://evil.example/&quot;&gt;');
    expect(body).toContain('&lt;script&gt;parent.location');
  });

  it('prints the whole document: the table fits the paper and the pills stay off it', () => {
    const doc = markdownDocument('| a | b |\n|---|---|\n| 1 | 2 |');
    const print = doc.slice(doc.indexOf('@media print'));
    expect(print).toMatch(/table \{[^}]*display: table[^}]*width: 100%/);
    expect(print).toMatch(/th, td \{[^}]*white-space: normal/);
    expect(print).toContain('thead { display: table-header-group; }');
    const html = renderToStaticMarkup(<PublicArtifact view={{ ...app, kind: 'markdown', content: '# Notes' }} universeUrl={UNIVERSE} />);
    // The page grows with the document in print, and the corner pills never print over it
    expect(html).toContain('print:relative');
    const hidden = html.indexOf('print:hidden');
    expect(hidden).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="downloadPill"')).toBeGreaterThan(hidden);
    expect(html.indexOf('data-testid="madeWithUniverse"')).toBeGreaterThan(hidden);
    expect(html).toContain('print:h-[var(--document-height,100dvh)]');
  });

  it('offers Download only on a document, with the choice only when it has a table', () => {
    const doc = (content: string) => renderToStaticMarkup(<PublicArtifact view={{ ...app, kind: 'markdown', content }} universeUrl={UNIVERSE} />);
    expect(renderToStaticMarkup(<PublicArtifact view={app} universeUrl={UNIVERSE} />)).not.toContain('downloadPill');
    const plain = doc('# Notes\n\n- one');
    expect(plain).toContain('data-testid="downloadPill"');
    expect(plain).not.toContain('aria-haspopup');
    const withTable = doc('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(withTable).toContain('aria-haspopup="menu"');
  });

  it('measures the document as paper, with the print rules it really prints with, and never prints the measuring copy', () => {
    const doc = markdownDocument('# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    // One hidden copy laid out at the width of a page; the same rules are written for it and for the print styles
    expect(doc.match(/id="paper"/g)).toHaveLength(1);
    expect(doc).toMatch(/\.paper \{[^}]*position: fixed[^}]*visibility: hidden/);
    expect(doc).toMatch(/\.paper table \{[^}]*display: table[^}]*width: 100%/);
    expect(doc).toMatch(/\.paper th, \.paper td \{[^}]*white-space: normal/);
    const print = doc.slice(doc.indexOf('@media print'), doc.indexOf('</style>'));
    expect(print).toMatch(/\.paper \{ display: none; \}/);
    expect(print).toMatch(/ th, td \{[^}]*white-space: normal/);
    // The copy is for measuring only: hidden from readers of the page
    expect(doc).toContain('id="paper" class="paper" aria-hidden="true"');
    // A long word in a cell may break anywhere on paper, so a table never grows wider than the page
    expect(print).toMatch(/ th, td \{[^}]*overflow-wrap: anywhere/);
  });

  it('starts watching the document only once it has a body, answers whenever the page asks, and reports several page widths', () => {
    // The script sits in the head: the body (and the measuring copy) can only be watched after the document is read
    expect(HEIGHT_SCRIPT).toMatch(/addEventListener\('DOMContentLoaded',function\(\)\{[^}]*ResizeObserver/);
    expect(HEIGHT_SCRIPT).toContain("addEventListener('message'");
    expect(HEIGHT_SCRIPT).toContain('e.source===parent');
    expect(HEIGHT_SCRIPT).toContain('[180,240,300,360,480,600,720,840]');
  });

  it('puts a Content-Security-Policy in the document that blocks every script but its own height one, and keeps Markdown headings', () => {
    const doc = markdownDocument('# Notes\n\n- one\n- two');
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("script-src 'unsafe");
    expect(doc).toContain('<h1>Notes</h1>');
    expect(doc).toContain('<li>one</li>');
  });

  it('draws a table as a table whose cells keep to one line, so a wide table scrolls sideways instead of squeezing to one letter per column', () => {
    const doc = markdownDocument('| # | Note |\n|---|---|\n| 1 | A long note about the calendar |');
    expect(doc).toContain('<table>');
    expect(doc).toContain('<td>A long note about the calendar</td>');
    // The page breaks words anywhere; a cell must not follow that rule or its column shrinks to a letter
    expect(doc).toMatch(/th, td \{[^}]*white-space: nowrap[^}]*overflow-wrap: normal/);
    expect(doc).toMatch(/table \{[^}]*display: block[^}]*overflow-x: auto/);
  });

  it('says one thing when the link is not available, with no way to tell why', () => {
    const html = renderToStaticMarkup(<LinkNotAvailable universeUrl={UNIVERSE} />);
    expect(html).toContain('This link is not available');
    expect(html).not.toContain('<iframe');
    expect(renderToStaticMarkup(<LinkNotAvailable universeUrl={UNIVERSE} tryAgain />)).toContain('Try again in a moment.');
  });
});
