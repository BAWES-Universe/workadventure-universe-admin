/** Which of a person's own Apps is the same service as a research App of the table: by the App's name, or by its link's host. */
jest.mock('@/lib/db', () => ({ prisma: {} }));
import { serviceOf } from '@/lib/instant/asker';

describe('the research App an own App is the same service as', () => {
  it('a link, a key app or a hosted sign-in of the service itself', () => {
    expect(serviceOf({ serverUrl: 'https://mcp.exa.ai/mcp' })).toBe('exa');
    expect(serviceOf({ serverUrl: 'https://api.exa.ai' })).toBe('exa');
    expect(serviceOf({ serverUrl: 'https://exa.ai/x' })).toBe('exa');
    expect(serviceOf({ serverUrl: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-x' })).toBe('tavily');
    expect(serviceOf({ serverUrl: 'HTTPS://MCP.TAVILY.COM/mcp' })).toBe('tavily');
  });

  it('a ready-made App by its name, spelled any way', () => {
    expect(serviceOf({ providerToolkit: 'EXA', serverUrl: 'https://backend.composio.dev/tool_router/x/mcp' })).toBe('exa');
    expect(serviceOf({ providerToolkit: 'tavily' })).toBe('tavily');
  });

  it('never a look-alike host, another service or something that is not a link', () => {
    expect(serviceOf({ serverUrl: 'https://notexa.ai/mcp' })).toBeNull();
    expect(serviceOf({ serverUrl: 'https://exa.ai.evil.example/mcp' })).toBeNull();
    expect(serviceOf({ serverUrl: 'https://example.com/?u=https://mcp.exa.ai' })).toBeNull();
    expect(serviceOf({ serverUrl: 'https://backend.composio.dev/tool_router/trs_exa/mcp' })).toBeNull();
    expect(serviceOf({ serverUrl: 'not a link' })).toBeNull();
    expect(serviceOf({ providerToolkit: 'gmail' })).toBeNull();
    expect(serviceOf({})).toBeNull();
  });
});
