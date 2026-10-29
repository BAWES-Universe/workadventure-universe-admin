import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactBox, LinkNotAvailable, PublicArtifact } from '@/components/public-artifact';
import { markdownDocument } from '@/lib/artifact-public';
import type { PublicView } from '@/lib/artifact-service';

const UNIVERSE = 'https://play.example';
const app: PublicView = { title: 'Quests board', kind: 'app', makerName: 'Scout', version: 2, url: 'https://artifacts.example/a/v2.html', content: null };

describe('the public artifact page', () => {
  it('is just the artifact filling the window in a locked frame, with only the floating pill to Universe', () => {
    const html = renderToStaticMarkup(<PublicArtifact view={app} universeUrl={UNIVERSE} />);
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
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

  it('says one thing when the link is not available, with no way to tell why', () => {
    const html = renderToStaticMarkup(<LinkNotAvailable universeUrl={UNIVERSE} />);
    expect(html).toContain('This link is not available');
    expect(html).not.toContain('<iframe');
    expect(renderToStaticMarkup(<LinkNotAvailable universeUrl={UNIVERSE} tryAgain />)).toContain('Try again in a moment.');
  });
});
