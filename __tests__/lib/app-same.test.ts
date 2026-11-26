import { addressWords, isOwnApp, KEY_NO_ANSWER_HOLDS_MS, looseName, ownCopyWorks, sameApp } from '@/lib/app-same';
import { sortOwnTool } from '@/lib/app-own-tools';

jest.mock('@/lib/db', () => ({ prisma: {} }));

describe('the same App (lib/app-same.ts)', () => {
  it('reads names loosely', () => {
    expect(looseName('Google_Calendar')).toBe('googlecalendar');
    expect(sameApp({ name: 'Google Calendar', serverUrl: null }, { key: 'googlecalendar' })).toBe(true);
    expect(sameApp({ name: 'tavily', serverUrl: null }, { key: 'x', name: 'Tavily' })).toBe(true);
  });

  it('knows an App by the name its own address is registered under, and by nothing else of the address', () => {
    expect(addressWords('https://mcp.exa.ai/mcp')).toEqual(['exa']);
    expect(addressWords('https://api.tavily.com')).toEqual(['tavily']);
    expect(addressWords('https://my-notion.example.co.uk/sse')).toEqual(['example']);
    expect(addressWords('https://shop.example.com.kw')).toEqual(['example']);
    expect(sameApp({ name: 'My search', serverUrl: 'https://mcp.exa.ai/mcp' }, { key: 'exa', name: 'Exa' })).toBe(true);
    // A part of the host before the registered name, or a part of a hyphenated name, is not the App (Sentry on #1043)
    expect(sameApp({ name: 'Bot', serverUrl: 'https://slack.mycorp.com/mcp' }, { key: 'slack', name: 'Slack' })).toBe(false);
    expect(sameApp({ name: 'Bot', serverUrl: 'https://slack-bot.corp.internal' }, { key: 'slack', name: 'Slack' })).toBe(false);
    expect(sameApp({ name: 'Maths', serverUrl: 'https://linear-algebra.example.com' }, { key: 'linear', name: 'Linear' })).toBe(false);
    // An address on a hosting service is the person's own name, never the service's (Opus read of #1043)
    expect(addressWords('https://my-tool.vercel.app/mcp')).toEqual(['mytool']);
    expect(addressWords('https://user.github.io')).toEqual(['user']);
    expect(addressWords('https://abc.supabase.co/functions/v1/mcp')).toEqual(['abc']);
    expect(addressWords('https://mcp.vercel.app')).toEqual([]);
    // A service's own address is the service, even where apps it hosts live under a sibling name
    expect(addressWords('https://mcp.render.com/mcp')).toEqual(['render']);
    expect(addressWords('https://mcp.netlify.com/mcp')).toEqual(['netlify']);
    expect(sameApp({ name: 'Tool', serverUrl: 'https://my-tool.vercel.app/mcp' }, { key: 'vercel', name: 'Vercel' })).toBe(false);
    expect(sameApp({ name: 'Site', serverUrl: 'https://user.github.io' }, { key: 'github', name: 'GitHub' })).toBe(false);
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
    expect(sortOwnTool('sendMessage', 'looksUp')).toBe('deletesOrSends');
    expect(sortOwnTool('deleteFile', 'looksUp')).toBe('deletesOrSends');
    expect(sortOwnTool('HTTPSendRequest', 'looksUp')).toBe('deletesOrSends');
    expect(sortOwnTool('searchDocuments', 'looksUp')).toBe('looksUp');
  });

  it('takes the suggestion otherwise, with Makes new things read as Changes things, and nothing suggested yet as Deletes or sends out', () => {
    expect(sortOwnTool('web_search_exa', 'looksUp')).toBe('looksUp');
    expect(sortOwnTool('tavily-search', 'looksUp')).toBe('looksUp');
    expect(sortOwnTool('create_page', 'changesThings')).toBe('changesThings');
    expect(sortOwnTool('make_image', 'makesNew')).toBe('changesThings');
    expect(sortOwnTool('web_search_exa', null)).toBe('deletesOrSends');
  });
});

describe('an own copy that works (ownCopyWorks)', () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  it('never counts a copy that is not connected, or one whose sign-in or key was refused, however long ago', () => {
    expect(ownCopyWorks(false, { kind: 'mcp' })).toBe(false);
    expect(ownCopyWorks(true, { kind: 'direct', signInLostAt: ago(10 * KEY_NO_ANSWER_HOLDS_MS) })).toBe(false);
    expect(ownCopyWorks(true, { kind: 'mcp' }, { signInLostAt: ago(1) })).toBe(false);
  });
  it('lets a key App that did not answer give way only for a while, then tries it again; a link App the bot server saw not answer gives way until it answers', () => {
    expect(ownCopyWorks(true, { kind: 'direct', noAnswerAt: ago(60_000) })).toBe(false);
    expect(ownCopyWorks(true, { kind: 'direct', noAnswerAt: ago(KEY_NO_ANSWER_HOLDS_MS + 1_000) })).toBe(true);
    expect(KEY_NO_ANSWER_HOLDS_MS).toBe(5 * 60_000);
    expect(ownCopyWorks(true, { kind: 'direct', noAnswerAt: ago(6 * 60_000) })).toBe(true);
    expect(ownCopyWorks(true, { kind: 'mcp', noAnswerAt: ago(10 * KEY_NO_ANSWER_HOLDS_MS) })).toBe(false);
    expect(ownCopyWorks(true, { kind: 'direct' }, { noAnswerAt: ago(10 * KEY_NO_ANSWER_HOLDS_MS) })).toBe(false);
  });
});
