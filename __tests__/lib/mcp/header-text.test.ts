/**
 * Text that cannot go into a header (an em dash from a pasted note) is named by its field when an app is added, changed or tested,
 * and never reaches fetch, which would only say "Cannot convert argument to a ByteString" (Exa on prod, 14 Nov).
 */
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  isAllowedServerIp: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: (value: string) => value.replace('encrypted:', '') }));

import { headerProblem, unsendableCharacter } from '@/lib/mcp/header-text';
import { createMcpServerSchema, unsendableIssueMessage } from '@/lib/mcp/server-input';
import { testMcpConnection } from '@/lib/mcp/test-connection';

const fetchBefore = global.fetch;
afterEach(() => {
  global.fetch = fetchBefore;
});

describe('unsendableCharacter', () => {
  it('finds what a header cannot carry and lets plain and accented Latin-1 text through', () => {
    expect(unsendableCharacter('sk-abc_123.XYZ')).toBeNull();
    expect(unsendableCharacter('café')).toBeNull();
    expect(unsendableCharacter('key — note')).toBe('—');
    expect(unsendableCharacter('“quoted”')).toBe('“');
    expect(unsendableCharacter('line\nbreak')).toBe('\n');
    expect(unsendableCharacter('مفتاح')).toBe('م');
  });
});

describe('headerProblem', () => {
  it('names the key, the token or the extra header that has the character, and what it is', () => {
    expect(headerProblem({ authType: 'api-key', authValue: 'abc — def' })).toBe('The key has an em dash (—), which cannot be sent. Retype it with plain letters, numbers and symbols.');
    expect(headerProblem({ authType: 'bearer', authValue: 'tok’en' })).toContain('The access token has a curly quote');
    expect(headerProblem({ authType: 'none', headers: { 'X-Tenant': 'acme — prod' } })).toContain('The value of the extra header “X-Tenant” has an em dash');
  });

  it('names an extra header whose name cannot be sent, and passes everything sendable', () => {
    expect(headerProblem({ authType: 'none', headers: { 'X Tenant': 'a' } })).toContain('extra header name');
    expect(headerProblem({ authType: 'none', headers: { 'X-Tenant': 'acme' } })).toBeNull();
    expect(headerProblem({ authType: 'oauth', authValue: '{"clientId":"café —"}' })).toBeNull();
    expect(headerProblem({ authType: 'none' })).toBeNull();
  });
});

describe('adding an app', () => {
  const input = { name: 'Exa', serverUrl: 'https://mcp.exa.ai/mcp' };
  it('refuses a key with an em dash and says which field', () => {
    const result = createMcpServerSchema.safeParse({ ...input, authType: 'api-key', authConfig: 'abc — def' });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]).toMatchObject({ path: ['authConfig'], message: expect.stringContaining('The key has an em dash') });
  });

  it('refuses an extra header value with an em dash and says which header', () => {
    const result = createMcpServerSchema.safeParse({ ...input, headers: { 'X-Note': 'a — b' } });
    expect(!result.success && result.error.issues[0]).toMatchObject({ path: ['headers'], message: expect.stringContaining('“X-Note”') });
  });

  it('gives routes the sentence to put in `error`, and nothing for other refusals', () => {
    const bad = createMcpServerSchema.safeParse({ ...input, authType: 'api-key', authConfig: 'abc \u2014 def' });
    expect(!bad.success && unsendableIssueMessage(bad.error.issues)).toContain('The key has an em dash');
    const other = createMcpServerSchema.safeParse({ ...input, authType: 'api-key' });
    expect(!other.success && unsendableIssueMessage(other.error.issues)).toBeNull();
  });

  it('takes a plain key', () => {
    expect(createMcpServerSchema.safeParse({ ...input, authType: 'api-key', authConfig: 'abc123' }).success).toBe(true);
  });
});

describe('testing an app saved with such text', () => {
  const server = { serverUrl: 'https://mcp.exa.ai/mcp', authType: 'bearer', authConfig: 'encrypted:abc — def' };

  it('says which field and never calls fetch', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await testMcpConnection(server);
    expect(result).toMatchObject({ success: false, toolCount: 0 });
    expect(result.error).toBe('The access token has an em dash (—), which cannot be sent. Retype it with plain letters, numbers and symbols.');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('says which extra header when the value is the one', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await testMcpConnection({ serverUrl: 'https://mcp.exa.ai/mcp', authType: 'none', authConfig: null, headers: { 'X-Note': 'a — b' } });
    expect(result.error).toContain('extra header “X-Note”');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the address of an app, by its parsed scheme', () => {
  const input = { name: 'Exa' };
  it('refuses an address that is not http or https, and takes HTTPS written in capitals as the revocation address', () => {
    expect(createMcpServerSchema.safeParse({ ...input, serverUrl: 'ftp://files.example.com/mcp' }).success).toBe(false);
    expect(createMcpServerSchema.safeParse({ ...input, serverUrl: 'https://mcp.exa.ai/mcp' }).success).toBe(true);
    const oauth = (revocationUrl: string) => createMcpServerSchema.safeParse({ ...input, serverUrl: 'https://mcp.exa.ai/mcp', authType: 'oauth', authConfig: JSON.stringify({ clientId: 'c', authorizeUrl: 'https://auth.example.com/a', tokenUrl: 'https://auth.example.com/t', revocationUrl }) });
    expect(oauth('HTTPS://auth.example.com/revoke').success).toBe(true);
    expect(oauth('http://auth.example.com/revoke').success).toBe(false);
  });
});
