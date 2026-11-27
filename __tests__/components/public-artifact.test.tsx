import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactBox, LinkNotAvailable, PublicArtifact } from '@/components/public-artifact';
import { marked } from 'marked';
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

  it("prints the owner's preview as just the document: the box has no border, corners, clipping or tint on paper, and the frame sits in a box it is measured by", () => {
    const html = renderToStaticMarkup(<ArtifactBox view={{ ...app, kind: 'markdown', content: '# Notes' }} />);
    for (const rule of ['print:overflow-visible', 'print:border-0', 'print:rounded-none', 'print:bg-white', 'print:min-h-0']) {
      expect(html).toContain(rule);
    }
    // The frame is inside the box the print steps ask for its own width, whatever surrounds it
    expect(html).toMatch(/container-type:inline-size[^>]*><iframe[^>]*data-document-frame/);
  });

  it('puts a Content-Security-Policy in the document that blocks every script but its own height one, and keeps Markdown headings', () => {
    const doc = markdownDocument('# Notes\n\n- one\n- two');
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("script-src 'unsafe");
    expect(doc).toContain('<h1>Notes</h1>');
    expect(doc).toContain('<li>one</li>');
  });

  describe('single new lines (the same drawing as the docs window in the game)', () => {
    // The document as drawn on screen: the first copy in the page (a hidden second copy follows it, for measuring the printed height)
    const body = (markdown: string) => markdownDocument(markdown).split('<body>')[1].split('<div id="paper"')[0];

    // The same three documents and the same expected HTML are in the game's textFiles test: the link page and the docs window
    // in the game must draw a document alike. (The game also adds target and rel to links; this page does it with <base target="_blank">.)
    const SAME_DOC_CASES: Record<string, { markdown: string; html: string }> = {
      handover: {
        markdown: "# Handover pack\n\nOwner: khalid@bawes.net\nRead from: three calendars\nRange read: 2026-10-28 to 2026-12-28\nNotes captured: 104\nRead on: 27 Nov 2026\n\nPart 1 is the ledger.\nPart 2 is the handover.",
        html: "<h1>Handover pack</h1>\n<p>Owner: <a href=\"mailto:khalid@bawes.net\">khalid@bawes.net</a><br>Read from: three calendars<br>Range read: 2026-10-28 to 2026-12-28<br>Notes captured: 104<br>Read on: 27 Nov 2026</p>\n<p>Part 1 is the ledger.<br>Part 2 is the handover.</p>\n",
      },
      normal: {
        markdown: "## Trip checklist\n\n- Adapter\n- Sunscreen\n  - SPF 50\n- Passport\n  keep it in the hand bag\n\n> Ask the hotel first.\n> Then the driver.\n\n1. Pack\n2. Check in\n\n```\nline one\nline two\n```\n\n| # | Date | Time |\n|---|------|------|\n| 1 | 2026-10-28 | 22:10 |\n| 2 | 2026-10-29 | 22:20 |\n\nLine ends with two spaces  \nso this is a hard break either way.",
        html: "<h2>Trip checklist</h2>\n<ul>\n<li>Adapter</li>\n<li>Sunscreen<ul>\n<li>SPF 50</li>\n</ul>\n</li>\n<li>Passport<br>keep it in the hand bag</li>\n</ul>\n<blockquote>\n<p>Ask the hotel first.<br>Then the driver.</p>\n</blockquote>\n<ol>\n<li>Pack</li>\n<li>Check in</li>\n</ol>\n<pre><code>line one\nline two\n</code></pre>\n<table>\n<thead>\n<tr>\n<th>#</th>\n<th>Date</th>\n<th>Time</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td>2026-10-28</td>\n<td>22:10</td>\n</tr>\n<tr>\n<td>2</td>\n<td>2026-10-29</td>\n<td>22:20</td>\n</tr>\n</tbody></table>\n<p>Line ends with two spaces<br>so this is a hard break either way.</p>\n",
      },
      wrapped: {
        markdown: "## Summary\n\nThe renewal window opens in March and the team has agreed to review all three\nvendor offers before the end of February, so that nothing is signed under\ntime pressure and the budget owner can see the numbers early.\n\nThe second paragraph was typed on one long line by a person, so it is the same before and after, whatever the window width is.",
        html: "<h2>Summary</h2>\n<p>The renewal window opens in March and the team has agreed to review all three<br>vendor offers before the end of February, so that nothing is signed under<br>time pressure and the budget owner can see the numbers early.</p>\n<p>The second paragraph was typed on one long line by a person, so it is the same before and after, whatever the window width is.</p>\n",
      },
    };

    it.each(Object.keys(SAME_DOC_CASES))('draws the %s document the way the docs window in the game does', (name) => {
      expect(body(SAME_DOC_CASES[name].markdown)).toBe(SAME_DOC_CASES[name].html);
    });

    it('keeps a single new line inside a paragraph as a line break, and a blank line as a new paragraph', () => {
      expect(body('Owner: Dana\nRead from: Hub\n\nNext paragraph\n')).toBe('<p>Owner: Dana<br>Read from: Hub</p>\n<p>Next paragraph</p>\n');
    });

    it('keeps a hand-wrapped line break mid-sentence (the known cost of the change)', () => {
      expect(body('A sentence that a writer wrapped\nby hand at the window edge.\n')).toContain('wrapped<br>by hand');
    });

    it('keeps a new line inside a list item and inside a quote as a line break', () => {
      const list = body('- one\n  continued\n- two\n');
      expect(list.match(/<li>/g)).toHaveLength(2);
      expect(list).toContain('<li>one<br>continued</li>');
      expect(list).toContain('<li>two</li>');
      expect(body('> first\n> second\n')).toContain('<blockquote>\n<p>first<br>second</p>\n</blockquote>');
    });

    it('draws lists, tables, code blocks and task items with no line breaks added', () => {
      const markdown = '# Title\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nline 1\nline 2\n```\n\n- [x] done\n- [ ] todo\n';
      const html = body(markdown);
      expect(html).not.toContain('<br');
      expect(html).toContain('<table>');
      expect(html).toContain('<th>A</th>');
      expect(html).toContain('<code class="language-js">line 1\nline 2\n</code>');
      expect(html.match(/<li>/g)).toHaveLength(7);
      // The same text drawn with the setting off (how it was drawn before) is identical
      expect(html).toBe(marked.parse(markdown, { async: false, gfm: true, breaks: false }));
    });

    it('draws a two-space hard break as one line break', () => {
      expect(body('first  \nsecond\n')).toBe('<p>first<br>second</p>\n');
    });
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
