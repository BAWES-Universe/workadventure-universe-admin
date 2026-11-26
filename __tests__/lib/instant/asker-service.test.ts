/** Which research Apps of the table one of a person's own Apps is the same App as: by the one rule of lib/app-same.ts (its name, or its address). */
jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/app-connections', () => ({ connectedState: jest.fn() }));
import { researchCoveredBy } from '@/lib/instant/asker';

const covered = (name: string, serverUrl: string | null) => [...researchCoveredBy([{ name, serverUrl }])];

describe('the research App an own App is the same App as', () => {
  it('a link or a key App of the service itself, whatever it is called', () => {
    expect(covered('My search', 'https://mcp.exa.ai/mcp')).toEqual(['exa']);
    expect(covered('x', 'https://api.exa.ai')).toEqual(['exa']);
    expect(covered('x', 'https://exa.ai/x')).toEqual(['exa']);
    expect(covered('x', 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-x')).toEqual(['tavily']);
    expect(covered('x', 'HTTPS://MCP.TAVILY.COM/mcp')).toEqual(['tavily']);
  });

  it('an own App by its name, spelled any way', () => {
    expect(covered('EXA', 'https://example.org/my-search')).toEqual(['exa']);
    expect(covered('Tavily', null)).toEqual(['tavily']);
  });

  it('never a look-alike address, another service or something that is not a link', () => {
    expect(covered('x', 'https://notexa.ai/mcp')).toEqual([]);
    expect(covered('x', 'https://exa.ai.evil.example/mcp')).toEqual([]);
    expect(covered('x', 'https://example.com/?u=https://mcp.exa.ai')).toEqual([]);
    expect(covered('x', 'https://backend.composio.dev/tool_router/trs_exa/mcp')).toEqual([]);
    expect(covered('x', 'not a link')).toEqual([]);
    expect(covered('Gmail', null)).toEqual([]);
  });
});
