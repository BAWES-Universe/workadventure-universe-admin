import { nameFromAddress } from '@/lib/mcp/app-names';

describe('the name read from an app’s address (game #2001, Add your own app)', () => {
  it.each([
    ['https://mcp.zapier.com/api/mcp', 'Zapier'],
    ['https://api.tavily.com/mcp', 'Tavily'],
    ['https://firecrawl.dev/mcp', 'Firecrawl'],
    ['https://auth.example.co.uk/oauth', 'Example'],
    ['https://MCP.Notion.com', 'Notion'],
  ])('reads %s as %s', (address, name) => expect(nameFromAddress(address)).toBe(name));

  it.each(['http://127.0.0.1/mcp', 'https://[::1]/mcp', 'http://localhost/mcp', 'not a link', '', null, undefined])('reads nothing from %s', (address) => {
    expect(nameFromAddress(address as string)).toBeNull();
  });
});
