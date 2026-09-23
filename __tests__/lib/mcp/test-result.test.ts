import {
  extractErrorCode,
  formatResultAge,
  readBodyWithLimit,
  redactCredentialMaterial,
  summarizeTestResult,
  truncateDetail,
  type McpTestResult,
} from '@/lib/mcp/test-result';

describe('readBodyWithLimit', () => {
  it('stops at the cap and cancels the rest of the stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });

    const text = await readBodyWithLimit(new Response(stream), 4096);

    // The cap bounds what is buffered, and cancelling stops the rest of the transfer
    // rather than letting a streaming failure response drain into memory.
    expect(text).toHaveLength(4096);
    expect(cancelled).toBe(true);
  });

  it('returns the whole body when it fits under the cap', async () => {
    const body = JSON.stringify({ error: 'invalid_token' });
    expect(await readBodyWithLimit(new Response(body))).toBe(body);
  });

  it('returns an empty string for a response with no body', async () => {
    expect(await readBodyWithLimit(new Response(null, { status: 401 }))).toBe('');
  });

  it('resolves instead of throwing when the stream fails mid-read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });

    await expect(readBodyWithLimit(new Response(stream))).resolves.toBe('');
  });
});

describe('redactCredentialMaterial', () => {
  it('redacts bearer tokens', () => {
    const out = redactCredentialMaterial('Authorization: Bearer abc123def456ghi789');
    expect(out).not.toContain('abc123def456ghi789');
    expect(out).toContain('[redacted]');
  });

  it('redacts JSON token fields', () => {
    const out = redactCredentialMaterial('{"access_token":"ya29.super-secret","refresh_token":"rt_abc123"}');
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('rt_abc123');
  });

  it('redacts query-style token parameters', () => {
    const out = redactCredentialMaterial('error=invalid_token&access_token=opaqueTokenValue123');
    expect(out).not.toContain('opaqueTokenValue123');
    expect(out).toContain('access_token=[redacted]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redactCredentialMaterial(`token ${jwt} rejected`);
    expect(out).not.toContain(jwt);
  });

  it('leaves a plain diagnostic untouched', () => {
    const header = 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api/mcp"';
    expect(redactCredentialMaterial(header)).toBe(header);
  });
});

describe('truncateDetail', () => {
  it('redacts before truncating, so a clipped secret is still redacted', () => {
    const out = truncateDetail(`{"access_token":"${'x'.repeat(200)}"}`, 30);
    expect(out).not.toContain('xxxx');
    expect(out).toContain('[redacted]');
  });

  it('returns null for empty input', () => {
    expect(truncateDetail(null)).toBeNull();
    expect(truncateDetail('')).toBeNull();
  });
});

describe('extractErrorCode', () => {
  it('pulls the error code out of an OAuth-shaped rejection', () => {
    expect(extractErrorCode('{"error":"invalid_token"}')).toBe('invalid_token');
  });

  it('pulls the error out of a framework-shaped rejection', () => {
    expect(
      extractErrorCode(
        '{"statusCode":401,"error":"Unauthorized","message":"The requesting user presented an invalid authentication token"}'
      )
    ).toBe('Unauthorized');
  });

  it('prefers a nested error message', () => {
    expect(extractErrorCode('{"error":{"code":-32600,"message":"Invalid Request"}}')).toBe('Invalid Request');
  });

  it('falls back to raw text for a non-JSON body', () => {
    expect(extractErrorCode('Unauthorized')).toBe('Unauthorized');
  });

  it('returns null for an empty body', () => {
    expect(extractErrorCode('')).toBeNull();
    expect(extractErrorCode(null)).toBeNull();
    expect(extractErrorCode('   ')).toBeNull();
  });
});

describe('formatResultAge', () => {
  const now = new Date('2026-09-22T12:00:00Z');

  it('describes recent and old results', () => {
    expect(formatResultAge(new Date('2026-09-22T11:59:40Z'), now)).toBe('just now');
    expect(formatResultAge(new Date('2026-09-22T11:30:00Z'), now)).toBe('30 minutes ago');
    expect(formatResultAge(new Date('2026-09-22T09:00:00Z'), now)).toBe('3 hours ago');
    expect(formatResultAge(new Date('2026-08-01T09:00:00Z'), now)).toBe('52 days ago');
  });

  it('returns null when there is no timestamp', () => {
    expect(formatResultAge(null, now)).toBeNull();
    expect(formatResultAge(undefined, now)).toBeNull();
  });
});

describe('summarizeTestResult', () => {
  const now = new Date('2026-09-22T12:00:00Z');

  it('renders a result stored before the new fields existed', () => {
    // Exactly the shape four connections hold today: no status, no errorCode.
    const legacy: McpTestResult = { success: true, toolCount: 37, toolNames: ['a'] };
    const summary = summarizeTestResult(legacy, { testedAt: '2026-07-31T10:00:00Z', now });
    expect(summary.tone).toBe('ok');
    expect(summary.label).toBe('Connected — 37 tools');
    expect(summary.detail).toBe('tested 53 days ago');
  });

  it('renders a legacy failure without the new fields', () => {
    const legacy: McpTestResult = {
      success: false,
      toolCount: 0,
      toolNames: [],
      error: 'Initialize failed: HTTP 401: Unauthorized',
    };
    const summary = summarizeTestResult(legacy, { testedAt: '2026-09-22T11:59:00Z', now });
    expect(summary.tone).toBe('error');
    expect(summary.label).toBe('Initialize failed: HTTP 401: Unauthorized');
    expect(summary.detail).toBe('tested just now');
  });

  it('never shows a connection with an expired token as green', () => {
    const result: McpTestResult = { success: true, toolCount: 37, toolNames: [] };
    const summary = summarizeTestResult(result, {
      testedAt: '2026-07-31T10:00:00Z',
      oauthExpiresAt: '2026-08-01T20:58:48Z',
      now,
    });
    expect(summary.tone).toBe('stale');
    expect(summary.label).toBe('Connected — 37 tools');
    expect(summary.detail).toContain('token expired');
    expect(summary.detail).toContain('re-authorize');
  });

  it('flags a renewable expired token without asking a human to re-authorize', () => {
    // The panel never refreshes, so a connection with a refresh token can sit expired
    // between bot polls. It is still flagged, but "re-authorize" would be wrong advice
    // for a token the next use renews (#193 review).
    const result: McpTestResult = { success: true, toolCount: 37, toolNames: [] };
    const summary = summarizeTestResult(result, {
      testedAt: '2026-09-22T09:00:00Z',
      oauthExpiresAt: '2026-09-22T11:00:00Z',
      reconnectRequired: false,
      now,
    });
    expect(summary.tone).toBe('stale');
    expect(summary.detail).toContain('token expired');
    expect(summary.detail).toContain('renewed automatically');
    expect(summary.detail).not.toContain('re-authorize');
  });

  it('never shows a stored success as green once a reconnect is required', () => {
    // Recording the verdict clears the stored expiry, so the expiry alone would show this
    // old success green right next to the Reconnect action (#193 review).
    const result: McpTestResult = { success: true, toolCount: 6, toolNames: [] };
    const summary = summarizeTestResult(result, {
      testedAt: '2026-09-20T10:00:00Z',
      oauthExpiresAt: null,
      reconnectRequired: true,
      now,
    });
    expect(summary.tone).toBe('stale');
    expect(summary.detail).toContain('reconnect required');
    expect(summary.detail).toContain('re-authorize');
  });

  it('keeps the expiry in the message when a reconnect is required and it is known', () => {
    const result: McpTestResult = { success: true, toolCount: 6, toolNames: [] };
    const summary = summarizeTestResult(result, {
      testedAt: '2026-09-20T10:00:00Z',
      oauthExpiresAt: '2026-09-21T10:00:00Z',
      reconnectRequired: true,
      now,
    });
    expect(summary.tone).toBe('stale');
    expect(summary.detail).toContain('token expired 2026-09-21 10:00Z');
    expect(summary.detail).toContain('re-authorize');
  });

  it('stays green for a valid token when no reconnect is required', () => {
    const result: McpTestResult = { success: true, toolCount: 2, toolNames: [] };
    const summary = summarizeTestResult(result, {
      testedAt: '2026-09-22T11:00:00Z',
      oauthExpiresAt: '2026-09-22T13:00:00Z',
      reconnectRequired: false,
      now,
    });
    expect(summary.tone).toBe('ok');
  });

  it('stays green while the stored token is still valid', () => {
    const result: McpTestResult = { success: true, toolCount: 2, toolNames: [] };
    const summary = summarizeTestResult(result, {
      testedAt: '2026-09-22T11:00:00Z',
      oauthExpiresAt: '2026-09-22T13:00:00Z',
      now,
    });
    expect(summary.tone).toBe('ok');
    expect(summary.detail).toBe('tested 1 hour ago');
  });

  it('shows the captured error code and WWW-Authenticate for a failure', () => {
    const result: McpTestResult = {
      success: false,
      toolCount: 0,
      toolNames: [],
      error: 'Initialize failed: HTTP 401: Unauthorized — invalid_token',
      status: 401,
      statusText: 'Unauthorized',
      errorCode: 'invalid_token',
      wwwAuthenticate: 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api/mcp"',
    };
    const summary = summarizeTestResult(result, { testedAt: '2026-09-22T11:59:30Z', now });
    expect(summary.tone).toBe('error');
    expect(summary.label).toContain('invalid_token');
    expect(summary.detail).toContain('401 Unauthorized');
    expect(summary.detail).toContain('error: invalid_token');
    expect(summary.detail).toContain('resource_metadata');
    expect(summary.detail).toContain('tested just now');
  });

  it('reports an untested connection', () => {
    expect(summarizeTestResult(null).tone).toBe('none');
    expect(summarizeTestResult(null).label).toBe('Not tested');
    expect(summarizeTestResult(undefined).tone).toBe('none');
  });
});
