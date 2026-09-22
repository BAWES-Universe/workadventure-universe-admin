import {
  applyRefreshResult,
  isAccessTokenStale,
  isReconnectRequired,
  markReconnectRequired,
  needsRefresh,
  parseOAuthConfig,
  refreshBlockedReason,
  resolveRequestedScopes,
  OFFLINE_ACCESS_SCOPE,
  type McpOAuthConfig,
} from '@/lib/mcp/oauth-token';

const NOW = new Date('2026-09-22T12:00:00Z').getTime();
const nowSeconds = Math.floor(NOW / 1000);

function config(overrides: Partial<McpOAuthConfig> = {}): McpOAuthConfig {
  return {
    clientId: 'client-abc',
    tokenUrl: 'https://auth.example.com/oauth2/token',
    authorizeUrl: 'https://auth.example.com/oauth2/authorize',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: nowSeconds + 3600,
    ...overrides,
  };
}

describe('parseOAuthConfig', () => {
  it('parses an object and rejects anything else', () => {
    expect(parseOAuthConfig('{"accessToken":"a"}')?.accessToken).toBe('a');
    expect(parseOAuthConfig('not json')).toBeNull();
    expect(parseOAuthConfig('["array"]')).toBeNull();
    expect(parseOAuthConfig('null')).toBeNull();
    expect(parseOAuthConfig('')).toBeNull();
  });
});

describe('isAccessTokenStale', () => {
  it('is stale when there is no access token', () => {
    expect(isAccessTokenStale(config({ accessToken: null }), NOW)).toBe(true);
  });

  it('is stale once past the token lifetime', () => {
    expect(isAccessTokenStale(config({ expiresAt: nowSeconds - 1 }), NOW)).toBe(true);
  });

  it('is stale inside the refresh skew, so a token is renewed before it dies', () => {
    // 4 minutes left, skew is 5.
    expect(isAccessTokenStale(config({ expiresAt: nowSeconds + 240 }), NOW)).toBe(true);
  });

  it('is not stale well before expiry', () => {
    expect(isAccessTokenStale(config({ expiresAt: nowSeconds + 3600 }), NOW)).toBe(false);
  });

  it('treats a token with no recorded expiry as usable', () => {
    // Providers may omit expires_in; refusing to use the token would break them.
    expect(isAccessTokenStale(config({ expiresAt: undefined }), NOW)).toBe(false);
  });
});

describe('needsRefresh', () => {
  it('refreshes a stale token that has a refresh token', () => {
    expect(needsRefresh(config({ expiresAt: nowSeconds - 1 }), NOW)).toBe(true);
  });

  it('does nothing without a refresh token', () => {
    expect(needsRefresh(config({ expiresAt: nowSeconds - 1, refreshToken: null }), NOW)).toBe(false);
  });

  it('does nothing once a human is required', () => {
    const marked = markReconnectRequired(config({ expiresAt: nowSeconds - 1 }), 'revoked', NOW);
    expect(needsRefresh(marked, NOW)).toBe(false);
  });

  it('does nothing while the token is still good', () => {
    expect(needsRefresh(config(), NOW)).toBe(false);
  });
});

describe('isReconnectRequired and refreshBlockedReason', () => {
  it('flags a connection whose provider issued no refresh token once its token dies', () => {
    const dead = config({ accessToken: null, refreshToken: null, expiresAt: undefined });
    expect(isReconnectRequired(dead, NOW)).toBe(true);
    expect(refreshBlockedReason(dead, NOW)).toContain('No access token');
  });

  it('explains the no-refresh-token case', () => {
    const stale: McpOAuthConfig = {
      accessToken: 'expired',
      expiresAt: nowSeconds - 1,
    };
    expect(isReconnectRequired(stale, NOW)).toBe(true);
    expect(refreshBlockedReason(stale, NOW)).toContain('no refresh token');
  });

  it('reports the stored reason once marked', () => {
    const marked = markReconnectRequired(config(), 'the provider rejected the refresh token', NOW);
    expect(isReconnectRequired(marked, NOW)).toBe(true);
    expect(refreshBlockedReason(marked, NOW)).toBe('the provider rejected the refresh token');
  });

  it('is healthy when the token is good', () => {
    expect(isReconnectRequired(config(), NOW)).toBe(false);
    expect(refreshBlockedReason(config(), NOW)).toBeNull();
  });
});

describe('applyRefreshResult', () => {
  it('persists the rotated refresh token', () => {
    const next = applyRefreshResult(config(), { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }, NOW);
    expect(next.accessToken).toBe('access-2');
    expect(next.refreshToken).toBe('refresh-2');
    expect(next.expiresAt).toBe(nowSeconds + 3600);
  });

  it('keeps the existing refresh token when the provider does not rotate', () => {
    const next = applyRefreshResult(config(), { access_token: 'access-2', expires_in: 60 }, NOW);
    expect(next.refreshToken).toBe('refresh-1');
  });

  it('clears a previous reconnect-required verdict', () => {
    const marked = markReconnectRequired(config(), 'revoked', NOW);
    const next = applyRefreshResult(marked, { access_token: 'access-2', refresh_token: 'refresh-2' }, NOW);
    expect(next.reconnectRequired).toBeUndefined();
  });

  it('refuses a response with no access token', () => {
    expect(() => applyRefreshResult(config(), {}, NOW)).toThrow(/no access_token/);
  });
});

describe('markReconnectRequired', () => {
  it('clears the dead credentials so the panel reports it as not connected', () => {
    const marked = markReconnectRequired(config(), 'provider rejected the refresh token', NOW);
    expect(marked.accessToken).toBeUndefined();
    expect(marked.refreshToken).toBeUndefined();
    expect(marked.expiresAt).toBeUndefined();
    expect(marked.reconnectRequired).toEqual({
      at: '2026-09-22T12:00:00.000Z',
      reason: 'provider rejected the refresh token',
    });
    // Provider endpoints are preserved: a human re-authorizing reuses them.
    expect(marked.tokenUrl).toBe('https://auth.example.com/oauth2/token');
  });
});

describe('resolveRequestedScopes', () => {
  it('adds offline_access when the server advertises it', () => {
    expect(resolveRequestedScopes('openid mcp', ['openid', 'mcp', OFFLINE_ACCESS_SCOPE])).toBe(
      'openid mcp offline_access'
    );
  });

  it('never asks for offline_access when the server does not advertise it', () => {
    expect(resolveRequestedScopes('mcp offline_access openid', ['mcp', 'openid'])).toBe('mcp openid');
  });

  it('leaves configured scopes untouched when nothing is known about the server', () => {
    expect(resolveRequestedScopes('mcp offline_access', null)).toBe('mcp offline_access');
    expect(resolveRequestedScopes('mcp offline_access', [])).toBe('mcp offline_access');
  });

  it('does not duplicate a scope that is already requested', () => {
    expect(resolveRequestedScopes('mcp offline_access', ['mcp', OFFLINE_ACCESS_SCOPE])).toBe('mcp offline_access');
  });

  it('handles absent and comma-separated scopes', () => {
    expect(resolveRequestedScopes(null, ['mcp'])).toBeNull();
    expect(resolveRequestedScopes('mcp,openid', ['mcp', 'openid'])).toBe('mcp openid');
  });
});

describe('reconnect-required boundary: expiry, not the refresh threshold', () => {
  // REFRESH_SKEW_SECONDS answers "should we refresh soon"; isReconnectRequired answers
  // "is it beyond automatic recovery". Sharing one predicate judged a connection
  // terminal five minutes early and then cleared a still-valid token.

  it('keeps a still-valid token on a connection that has no refresh token', () => {
    const nearlyExpired: McpOAuthConfig = {
      accessToken: 'still-valid',
      expiresAt: nowSeconds + 120,
    };
    expect(isAccessTokenStale(nearlyExpired, NOW)).toBe(true); // inside the refresh skew
    expect(isReconnectRequired(nearlyExpired, NOW)).toBe(false);
    expect(refreshBlockedReason(nearlyExpired, NOW)).toBeNull();
    expect(needsRefresh(nearlyExpired, NOW)).toBe(false); // nothing to redeem, but no verdict either
  });

  it('is terminal one second past real expiry', () => {
    const justExpired: McpOAuthConfig = { accessToken: 'dead', expiresAt: nowSeconds - 1 };
    expect(isReconnectRequired(justExpired, NOW)).toBe(true);
    expect(refreshBlockedReason(justExpired, NOW)).toContain('no refresh token');
  });
});
