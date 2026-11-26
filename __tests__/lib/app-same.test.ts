import { addressWords, isOwnApp, looseName, sameApp } from '@/lib/app-same';
import { sortOwnTool } from '@/lib/app-own-tools';

jest.mock('@/lib/db', () => ({ prisma: {} }));

describe('the same App (lib/app-same.ts)', () => {
  it('reads names loosely', () => {
    expect(looseName('Google_Calendar')).toBe('googlecalendar');
    expect(sameApp({ name: 'Google Calendar', serverUrl: null }, { key: 'googlecalendar' })).toBe(true);
    expect(sameApp({ name: 'tavily', serverUrl: null }, { key: 'x', name: 'Tavily' })).toBe(true);
  });

  it('knows an App by a word of its own address, never by the ending or a word every address has', () => {
    expect(addressWords('https://mcp.exa.ai/mcp')).toEqual(['exa']);
    expect(addressWords('https://api.tavily.com')).toEqual(['tavily']);
    expect(addressWords('https://my-notion.example.co.uk/sse')).toEqual(['mynotion', 'notion', 'example']);
    expect(sameApp({ name: 'My search', serverUrl: 'https://mcp.exa.ai/mcp' }, { key: 'exa', name: 'Exa' })).toBe(true);
    expect(sameApp({ name: 'Search', serverUrl: 'https://mcp.search.ai/mcp' }, { key: 'mcp', name: 'MCP' })).toBe(false);
    expect(sameApp({ name: 'Search', serverUrl: 'https://search.ai' }, { key: 'ai', name: 'AI' })).toBe(false);
  });

  it('never matches on nothing: no names, a bare address, or an address that is not one', () => {
    expect(sameApp({ name: '', serverUrl: '' }, { key: '', name: '' })).toBe(false);
    expect(sameApp({ name: 'x', serverUrl: 'http://10.0.0.1/exa' }, { key: 'exa' })).toBe(false);
    expect(sameApp({ name: 'x', serverUrl: 'not a link' }, { key: 'exa' })).toBe(false);
    expect(addressWords('http://localhost:3000')).toEqual([]);
  });

  it('counts as own: a link, a listed App and a key App; never a ready-made App or Universe\'s GitHub', () => {
    expect(isOwnApp({ source: 'link', kind: 'mcp' })).toBe(true);
    expect(isOwnApp({ source: 'listed', kind: 'mcp' })).toBe(true);
    expect(isOwnApp({ source: 'direct', kind: 'direct' })).toBe(true);
    expect(isOwnApp({ source: 'ready_made', kind: 'mcp' })).toBe(false);
    expect(isOwnApp({ source: 'github', kind: 'mcp' })).toBe(false);
    expect(isOwnApp(null)).toBe(false);
  });
});

describe('sorting a tool of the person\'s own App (the rules of #1042)', () => {
  it('puts a name that sends, deletes or pays under Deletes or sends out, whatever was suggested', () => {
    expect(sortOwnTool('send_email', 'looksUp')).toBe('deletesOrSends');
    expect(sortOwnTool('delete-page', 'changesThings')).toBe('deletesOrSends');
  });

  it('takes the suggestion otherwise, with Makes new things read as Changes things, and nothing suggested yet as Deletes or sends out', () => {
    expect(sortOwnTool('web_search_exa', 'looksUp')).toBe('looksUp');
    expect(sortOwnTool('tavily-search', 'looksUp')).toBe('looksUp');
    expect(sortOwnTool('create_page', 'changesThings')).toBe('changesThings');
    expect(sortOwnTool('make_image', 'makesNew')).toBe('changesThings');
    expect(sortOwnTool('web_search_exa', null)).toBe('deletesOrSends');
  });
});
