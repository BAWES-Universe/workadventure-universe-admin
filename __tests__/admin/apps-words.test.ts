import { readFileSync } from 'fs';
import { join } from 'path';
import { describeToolSignIn } from '@/lib/tool-signin-words';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The text a person reads in a page's JSX and string literals, without imports, comments and code-only names. */
function visibleWords(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .filter((line) => !/^\s*import /.test(line) && !/from '/.test(line))
    .join('\n');
}

describe('one name: Apps (#2001, I1)', () => {
  const pages = ['app/admin/bots/[id]/mcp-servers/page.tsx', 'app/admin/bots/mcp-servers/page.tsx'];

  it.each(pages)('%s never says MCP server, tool server or connector to a person', (page) => {
    const words = visibleWords(read(page));
    expect(words).not.toMatch(/MCP servers?\b/);
    expect(words).not.toMatch(/tool servers?/i);
    expect(words).not.toMatch(/connectors?\b/i);
  });

  it('says MCP in one place only, the hint under "Add your own app"', () => {
    const words = visibleWords(read(pages[0])) + visibleWords(read(pages[1]));
    const marks = words.match(/\bMCP\b/g) ?? [];
    expect(marks).toHaveLength(1);
    expect(words).toContain('Paste its MCP link, like Firecrawl');
  });

  it('titles the pages Apps and links to them as Apps', () => {
    expect(read(pages[0])).toContain('title="Apps"');
    expect(read(pages[1])).toContain('title="Apps"');
    expect(read('app/admin/config/navigation.ts')).toContain("label: 'Apps'");
    expect(read('app/admin/config/routes.ts')).not.toMatch(/MCP servers/);
  });

  it('the Show app use switch and its saved errors say app use, not tool calls', () => {
    const words = visibleWords(read('components/bot-tool-call-switch.tsx'));
    expect(words).toContain('label="Show app use"');
    expect(words).not.toMatch(/tool calls/i);
  });

  it('the lost sign-in notice says apps, never tools', () => {
    const notice = describeToolSignIn({ botId: 'b', bot: 'Brick', universe: null, servers: [{ id: 's', name: 'Tavily', kind: 'key', at: '2026-11-12T00:00:00Z' }] });
    expect(notice.body).toContain('apps page');
    expect(notice.body).not.toMatch(/\btools?\b/i);
  });
});
