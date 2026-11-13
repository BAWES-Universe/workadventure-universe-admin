import { decryptApiKey } from '@/lib/encryption';
import { extractErrorCode, readBodyWithLimit, truncateDetail, MAX_TOOL_PAGES } from '@/lib/mcp/test-result';
import { isAllowedServerIp, isAllowedServerUrl } from '@/lib/mcp/outbound-guard';

interface McpToolDescriptor {
  name?: string;
  function?: { name?: string };
  [key: string]: unknown;
}

/** The most of an event stream read while waiting for the answer: a server that never stops sending is cut off here. */
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

/** The data of one event of an event stream: its `data:` lines joined with newlines (per the SSE spec), or null when it has none. */
function eventData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

/** The message in one event that answers the request with this id: notifications and answers to other requests are skipped. */
function answerIn(frame: string, expectedId: string): Record<string, unknown> | null {
  const data = eventData(frame);
  if (data === null) return null;
  try {
    const message = JSON.parse(data) as unknown;
    if (message && typeof message === 'object' && !Array.isArray(message) && String((message as { id?: unknown }).id) === expectedId) {
      return message as Record<string, unknown>;
    }
  } catch {
    // Not JSON: not an answer
  }
  return null;
}

/** Line endings of an event stream are \n, \r\n or \r: all read as \n, so events split the same way whichever a server sends. */
const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * Parse an MCP server HTTP response, handling both standard JSON-RPC and Streamable HTTP (SSE via text/event-stream) response
 * formats (Linear's MCP endpoint needs the second). In an event stream the answer is the message with the id of the request: a
 * notification the server sends first is not mistaken for it. An event stream is read as it arrives and closed once the answer is
 * in, so a server that keeps the stream open after answering does not hold the test until it times out.
 */
async function parseMcpResponseBody(response: Response, expectedId: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let read = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          read += value.byteLength;
          buffer += decoder.decode(value, { stream: true });
        }
        if (done) buffer += decoder.decode();
        // A \r at the very end may be the first half of \r\n: it waits for the next chunk
        const hold = !done && buffer.endsWith('\r');
        const frames = normalizeNewlines(hold ? buffer.slice(0, -1) : buffer).split('\n\n');
        // The last piece is an event not finished yet (or, at the end of the stream, the last one)
        const tail = frames.pop() ?? '';
        for (const frame of frames) {
          const answer = answerIn(frame, expectedId);
          if (answer) return answer;
        }
        if (done) {
          const last = answerIn(tail, expectedId);
          if (last) return last;
          break;
        }
        buffer = tail + (hold ? '\r' : '');
        if (read > MAX_STREAM_BYTES) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error('No answer to the request found in the event stream');
  }

  const text = await response.text();
  // An event stream sent without its content type
  if (text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
    for (const frame of normalizeNewlines(text).split('\n\n')) {
      const answer = answerIn(frame, expectedId);
      if (answer) return answer;
    }
    throw new Error('No answer to the request found in the event stream');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Diagnostic fields carried from a failing HTTP response into the stored result. */
interface McpTestFailureDetail {
  status?: number;
  statusText?: string;
  errorCode?: string | null;
  wwwAuthenticate?: string | null;
  errorBody?: string | null;
}

/**
 * Normalise captured failure detail for storage. Nullable rather than absent so a
 * result stored before this change still renders (see lib/mcp/test-result).
 */
function failureFields(source: McpTestFailureDetail) {
  return {
    status: source.status ?? null,
    statusText: source.statusText ?? null,
    errorCode: source.errorCode ?? null,
    wwwAuthenticate: source.wwwAuthenticate ?? null,
    errorBody: source.errorBody ?? null,
  };
}

/**
 * Build the failure payload for a response we could not use.
 *
 * A status text alone ("Unauthorized") never names the cause. The response body
 * carries the error code (e.g. `invalid_token`) and the WWW-Authenticate header
 * points at the resource-metadata document that explains the rejection. Both are
 * captured here — redacted and truncated — so the stored result can be diagnosed
 * later without reproducing the failure.
 */
async function describeFailure(
  response: Response,
  responseBody?: string
): Promise<{
  success: false;
  error: string;
  status: number;
  statusText: string;
  errorCode: string | null;
  wwwAuthenticate: string | null;
  errorBody: string | null;
}> {
  // Read through a byte cap: this is a server the operator configured but does not
  // control, and a failing endpoint that streams megabytes would otherwise be buffered
  // in full before truncateDetail ever sees it. Covers both failure call sites, the
  // direct response and the followed redirect, which both land here without a body.
  const rawBody = responseBody ?? (await readBodyWithLimit(response));
  const errorCode = extractErrorCode(rawBody);
  // The reason phrase is chosen by the server, so it is stored text like any other and
  // goes through the same redact-then-truncate as the body and the challenge header: an
  // endpoint can echo credential material there, and it can be arbitrarily long. This
  // also sanitises the value embedded in `error`, which is what the panel displays.
  const statusText = truncateDetail(response.statusText) || '';
  return {
    success: false,
    error: `HTTP ${response.status}${statusText ? `: ${statusText}` : ''}${errorCode ? ` \u2014 ${errorCode}` : ''}`,
    status: response.status,
    statusText,
    errorCode,
    // Redact-then-truncate, like the body: the stored field is documented as redacted
    // and, unlike the body, it previously had no length cap either.
    wwwAuthenticate: truncateDetail(response.headers.get('www-authenticate')),
    errorBody: truncateDetail(rawBody),
  };
}

/** What a server's error answer says, redacted and cut like every other text a server sends back: it may echo the credentials it was sent. */
function rpcErrorText(error: unknown): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  return truncateDetail(typeof message === 'string' && message ? message : JSON.stringify(error)) ?? 'unknown error';
}

/** Calls initialize and tools/list on an app's link with its stored sign-in (decrypted here only), through the same address guards at every hop. */
export async function testMcpConnection(server: { serverUrl: string; authType: string; authConfig: string | null; headers?: Record<string, string> | null }): Promise<{
  success: boolean;
  toolCount: number;
  toolNames: string[];
  /** True when the app has more pages of tools than are read: the list is the first pages, not everything. */
  incomplete?: boolean;
  error?: string;
  status?: number | null;
  statusText?: string | null;
  errorCode?: string | null;
  wwwAuthenticate?: string | null;
  errorBody?: string | null;
}> {
  // Decrypt authConfig if present
  let authValue: string | null = null;
  if (server.authConfig) {
    try {
      const decrypted = decryptApiKey(server.authConfig);
      if (server.authType === 'oauth') {
        // OAuth authConfig is JSON with an accessToken field
        try {
          const oauthConfig = JSON.parse(decrypted);
          // Reject OAuth configs without a usable access token
          if (!oauthConfig.accessToken) {
            return {
              success: false,
              toolCount: 0,
              toolNames: [],
              error: 'Reconnect required: no OAuth access token is stored for this connection.',
            };
          }
          authValue = oauthConfig.accessToken || null;
        } catch {
          return {
            success: false,
            toolCount: 0,
            toolNames: [],
            error: 'Invalid OAuth config — expected JSON with accessToken',
          };
        }
      } else {
        authValue = decrypted;
      }
    } catch (error) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: 'Failed to decrypt credentials — encryption key may be misconfigured',
      };
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if ((server.authType === 'bearer' || server.authType === 'oauth') && authValue) {
    headers['Authorization'] = `Bearer ${authValue}`;
  } else if (server.authType === 'api-key' && authValue) {
    headers['X-API-Key'] = authValue;
  }

  // Merge user-configured custom headers (e.g., multi-tenancy, versioning, Cloudflare bypass)
  if (server.headers) {
    for (const [key, value] of Object.entries(server.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
  }

  try {
    // SSRF guard: reject internal/private addresses before making network request
    if (!isAllowedServerUrl(server.serverUrl)) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: 'Server URL points to an internal or private address',
      };
    }

    // DNS-level SSRF guard: resolve hostname and verify resolved IPs are not private
    const ipCheck = await isAllowedServerIp(server.serverUrl);
    if (!ipCheck.allowed) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: ipCheck.error || 'Server URL resolves to a blocked address',
      };
    }

    // The headers a redirect gets: all of them on the same origin (an authenticated /mcp that redirects to /mcp/ still needs its
    // sign-in), only the two that carry no secret and no session on any other origin (prevents leaking bearer tokens, API keys,
    // session ids and custom credential headers such as a Cloudflare service token to a redirect target)
    function headersForRedirect(from: string, to: string, h: Record<string, string>): Record<string, string> {
      if (new URL(from).origin === new URL(to).origin) return { ...h };
      const safe: Record<string, string> = {};
      for (const [key, value] of Object.entries(h)) {
        if (key.toLowerCase() === 'content-type' || key.toLowerCase() === 'accept') safe[key] = value;
      }
      return safe;
    }

    // Helper to follow a redirect manually with SSRF validation before each hop
    async function followRedirect(url: string, headers: Record<string, string>, body: string, redirectCount = 0): Promise<Response> {
      if (redirectCount > 5) {
        throw new Error('Too many redirects');
      }
      // Validate redirect target before following (prevents redirect-based SSRF)
      if (!isAllowedServerUrl(url)) {
        throw new Error('Server redirected to an internal or private address');
      }
      const redirectIpCheck = await isAllowedServerIp(url);
      if (!redirectIpCheck.allowed) {
        throw new Error(redirectIpCheck.error || 'Redirect target resolves to a blocked address');
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new Error('Redirect response missing Location header');
        }
        // Resolve relative redirects against the current URL
        const redirectUrl = new URL(location, url).toString();
        return followRedirect(redirectUrl, headersForRedirect(url, redirectUrl, headers), body, redirectCount + 1);
      }
      return res;
    }

    // Helper to send a single MCP JSON-RPC POST request to the server URL,
    // handling redirects with SSRF-safe redirect validation.
    async function sendMcpRequest(body: string, expectedId: string | null): Promise<{
      success: boolean;
      data?: Record<string, unknown>;
      headers?: Record<string, string>;
      error?: string;
      status?: number;
      statusText?: string;
      errorCode?: string | null;
      wwwAuthenticate?: string | null;
      errorBody?: string | null;
    }> {
      const res = await fetch(server.serverUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      });

      // Handle redirect via the same SSRF-safe followRedirect
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          return {
            success: false,
            error: 'Redirect response missing Location header',
            status: res.status,
            // Second write site for this field, and the one that does not pass through
            // describeFailure: sanitise it here too rather than storing the raw phrase.
            statusText: truncateDetail(res.statusText) ?? undefined,
            errorCode: null,
            wwwAuthenticate: null,
            errorBody: null,
          };
        }
        const redirectUrl = new URL(location, server.serverUrl).toString();
        const followed = await followRedirect(redirectUrl, headersForRedirect(server.serverUrl, redirectUrl, headers), body).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Redirect failure';
          return new Response(null, { status: 502, statusText: msg });
        });
        if (!followed.ok) {
          return await describeFailure(followed);
        }
        const resHeaders: Record<string, string> = {};
        followed.headers.forEach((v: string, k: string) => { resHeaders[k] = v; });
        if (expectedId === null) await followed.body?.cancel().catch(() => undefined);
        return { success: true, data: expectedId === null ? {} : await parseMcpResponseBody(followed, expectedId), headers: resHeaders };
      }

      if (!res.ok) {
        return await describeFailure(res);
      }

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v: string, k: string) => { resHeaders[k] = v; });
      if (expectedId === null) await res.body?.cancel().catch(() => undefined);
      return { success: true, data: expectedId === null ? {} : await parseMcpResponseBody(res, expectedId), headers: resHeaders };
    }

    // Step 1: Initialize MCP session (required by MCP Streamable HTTP spec)
    const initResult = await sendMcpRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'workadventure-mcp-test',
            version: '1.0.0',
          },
        },
      }),
      'init'
    );

    if (!initResult.success) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: `Initialize failed: ${initResult.error}`,
        ...failureFields(initResult),
      };
    }

    if (initResult.data?.error) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: `Initialize error: ${rpcErrorText(initResult.data.error)}`,
        ...failureFields(initResult),
      };
    }

    // Per MCP Streamable HTTP spec, session ID is transmitted in the
    // Mcp-Session-Id HTTP response header, not in the JSON body.
    // Check header first, then fall back to body for non-spec servers.
    const sessionId =
        (initResult.headers?.['mcp-session-id']) ||
        (initResult.data as any)?.result?.sessionId as string | undefined;
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    // The session is open: the server is told so (a server may wait for this before it lists anything). Its answer is empty
    // (202); one that refuses it is left to the list below, which shows any real refusal.
    await sendMcpRequest(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), null).catch(() => undefined);

    // Step 2: Call tools/list, every page of it
    const toolNames: string[] = [];
    const seenNames = new Set<string>();
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let incomplete = false;
    for (let page = 1; page <= MAX_TOOL_PAGES; page += 1) {
      const resultResponse = await sendMcpRequest(
        JSON.stringify({
          jsonrpc: '2.0',
          id: String(page),
          method: 'tools/list',
          params: cursor ? { cursor } : {},
        }),
        String(page)
      );

      if (!resultResponse.success) {
        return {
          success: false,
          toolCount: 0,
          toolNames: [],
          error: resultResponse.error,
          ...failureFields(resultResponse),
        };
      }

      const data = resultResponse.data!;

      if (data?.error) {
        return {
          success: false,
          toolCount: 0,
          toolNames: [],
          error: `MCP error: ${rpcErrorText(data.error)}`,
          ...failureFields(resultResponse),
        };
      }

      // The answer to the list has the list (an empty one is an app with no tools; no list is not), and each tool a name
      const result = data?.result;
      const tools = result && typeof result === 'object' ? (result as { tools?: unknown }).tools : undefined;
      if (!Array.isArray(tools)) {
        return { success: false, toolCount: 0, toolNames: [], error: 'The app did not answer the list of what it can do' };
      }
      for (const tool of tools as McpToolDescriptor[]) {
        const named = tool && typeof tool === 'object' ? (tool.name ?? tool.function?.name) : undefined;
        if (typeof named !== 'string' || !named.trim()) {
          return { success: false, toolCount: 0, toolNames: [], error: 'The app sent a tool without a name' };
        }
        if (!seenNames.has(named)) {
          seenNames.add(named);
          toolNames.push(named);
        }
      }
      const next = (result as { nextCursor?: unknown }).nextCursor;
      if (typeof next !== 'string' || !next) break;
      // A page is still offered but is not read (a cursor already followed, or past the last page that is read): the list says so
      // rather than pass for everything
      if (seenCursors.has(next) || page === MAX_TOOL_PAGES) {
        incomplete = true;
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }
    return {
      success: true,
      toolCount: toolNames.length,
      toolNames,
      ...(incomplete ? { incomplete: true } : {}),
    };
  } catch (error: unknown) {
    const err = error as Record<string, unknown>;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: 'Connection timed out after 10 seconds',
      };
    }
    return {
      success: false,
      toolCount: 0,
      toolNames: [],
      error: typeof err.message === 'string' ? err.message : 'Connection failed',
    };
  }
}
