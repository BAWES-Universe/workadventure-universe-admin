import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactBox, LinkNotAvailable, PublicArtifact } from '@/components/public-artifact';
import { marked } from 'marked';
import { markdownDocument } from '@/lib/artifact-public';
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

  it('draws a document from its text in a frame with every permission off but opening links in a new tab', () => {
    const html = renderToStaticMarkup(<PublicArtifact view={{ ...app, kind: 'markdown', content: '# Notes\n\n<script>alert(1)</script>' }} universeUrl={UNIVERSE} />);
    expect(html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain('allow-scripts');
    expect(html).toContain('srcDoc=');
    expect(html).not.toContain('src="https://artifacts.example');
  });

  it('puts a Content-Security-Policy in the document that blocks scripts, and keeps Markdown headings', () => {
    const doc = markdownDocument('# Notes\n\n- one\n- two');
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("script-src");
    expect(doc).toContain('<h1>Notes</h1>');
    expect(doc).toContain('<li>one</li>');
  });

  describe('single new lines (the same drawing as the docs window in the game)', () => {
    const body = (markdown: string) => markdownDocument(markdown).split('<body>')[1].replace('</body></html>', '');

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

  it('says one thing when the link is not available, with no way to tell why', () => {
    const html = renderToStaticMarkup(<LinkNotAvailable universeUrl={UNIVERSE} />);
    expect(html).toContain('This link is not available');
    expect(html).not.toContain('<iframe');
    expect(renderToStaticMarkup(<LinkNotAvailable universeUrl={UNIVERSE} tryAgain />)).toContain('Try again in a moment.');
  });
});
