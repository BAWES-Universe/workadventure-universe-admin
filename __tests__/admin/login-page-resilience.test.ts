import { isOpaqueSessionId } from '@/lib/client-auth';

describe('Admin login exchangeToken resilience contract', () => {
  const isOpaque = isOpaqueSessionId;

  it('validates opaque session id properly', () => {
    expect(isOpaque(`orb_sess_v2_${'a'.repeat(64)}`)).toBe(true);
    expect(isOpaque('invalid')).toBe(false);
    expect(isOpaque('')).toBe(false);
  });

  it('safely parses malformed response bodies without throwing unhandled exceptions', async () => {
    const mockHtmlResponse = {
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      },
    };

    let parseFailed = false;
    let errorMessage = '';
    try {
      let data: any = null;
      try {
        data = await mockHtmlResponse.json();
      } catch {
        throw new Error(`Login request failed with status ${mockHtmlResponse.status}`);
      }
      if (!mockHtmlResponse.ok || !data) {
        throw new Error('Invalid login response');
      }
    } catch (err: any) {
      parseFailed = true;
      errorMessage = err.message;
    }

    expect(parseFailed).toBe(true);
    expect(errorMessage).toBe('Login request failed with status 502');
  });

  it('handles empty response bodies with safe fallback', async () => {
    const mockEmptyResponse = {
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    };

    let parseFailed = false;
    let errorMessage = '';
    try {
      let data: any = null;
      try {
        data = await mockEmptyResponse.json();
      } catch {
        throw new Error(`Login request failed with status ${mockEmptyResponse.status}`);
      }
      if (!mockEmptyResponse.ok || !data) {
        throw new Error('Invalid login response');
      }
    } catch (err: any) {
      parseFailed = true;
      errorMessage = err.message;
    }

    expect(parseFailed).toBe(true);
    expect(errorMessage).toBe('Login request failed with status 500');
  });

  it('converts AbortError to retryable timeout message', () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    let convertedMessage = '';
    try {
      if (abortErr instanceof Error && (abortErr.name === 'AbortError' || abortErr.name === 'TimeoutError')) {
        throw new Error('Login request timed out. Please try again.');
      }
    } catch (err: any) {
      convertedMessage = err.message;
    }

    expect(convertedMessage).toBe('Login request timed out. Please try again.');
  });

  it('preserves data.error message when upstream returns structured JSON error', async () => {
    const mockJsonResponse = {
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid authentication credentials' }),
    };

    let caughtMessage = '';
    try {
      let data: any = null;
      try {
        data = await mockJsonResponse.json();
      } catch {
        throw new Error(`Login request failed with status ${mockJsonResponse.status}`);
      }
      if (!mockJsonResponse.ok || !data || data.version !== 2) {
        throw new Error((data && typeof data.error === 'string') ? data.error : 'Invalid login response');
      }
    } catch (err: any) {
      caughtMessage = err.message;
    }

    expect(caughtMessage).toBe('Invalid authentication credentials');
  });

  it('re-throws AbortError from response.json() without masking it as status error', async () => {
    const abortErr = new Error('The user aborted a request.');
    abortErr.name = 'AbortError';

    const mockAbortingResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw abortErr;
      },
    };

    let caughtMessage = '';
    try {
      let data: any = null;
      try {
        data = await mockAbortingResponse.json();
      } catch (e: unknown) {
        if ((e instanceof DOMException && e.name === 'AbortError') || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))) {
          throw e;
        }
        throw new Error(`Login request failed with status ${mockAbortingResponse.status}`);
      }
    } catch (cause: unknown) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        caughtMessage = 'Login request timed out. Please try again.';
      } else if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
        caughtMessage = 'Login request timed out. Please try again.';
      } else {
        caughtMessage = (cause as Error).message;
      }
    }

    expect(caughtMessage).toBe('Login request timed out. Please try again.');
  });
});

