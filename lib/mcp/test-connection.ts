import { decryptApiKey } from '@/lib/encryption';
import { extractErrorCode, readBodyWithLimit, truncateDetail, MAX_TOOL_PAGES } from '@/lib/mcp/test-result';
import { isAllowedServerUrl, pinnedFetch } from '@/lib/mcp/outbound-guard';
import { headerProblem } from '@/lib/mcp/header-text';

interface McpToolDescriptor {
  name?: string;
  function?: { name?: string; description?: string };
  [key: string]: unknown;
}

/**
 * What one tool takes and gives back, by field name only (game #2006): the names of its inputs and which are required, and the
 * names of the fields of its structured answer when it declares them (`outputSchema`), else null. Never a default, an example or
 * a description of a field: the owner picks what other people may ask for from these names.
 */
export interface McpToolShape {
  name: string;
  description: string | null;
  inputs: { name: string; required: boolean }[];
  outputs: string[] | null;
}

export const MAX_SHAPE_FIELDS = 100;

/** The protocol headers of every request, and the only ones a request to another origin carries. */
const FIXED_HEADERS: Readonly<Record<string, string>> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

/** The version asked for, and the versions this check can speak: the one the app answers with is sent on every later request. */
const REQUESTED_PROTOCOL_VERSION = '2025-06-18';
const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

const allPropertyNames = (schema: unknown): string[] => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties);
};

const propertyNames = (schema: unknown): string[] | null => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return Object.keys(properties).slice(0, MAX_SHAPE_FIELDS);
};

export function shapeOfTool(tool: McpToolDescriptor, name: string): McpToolShape {
  const input = (tool.inputSchema ?? (tool.function as { parameters?: unknown } | undefined)?.parameters) as { required?: unknown } | undefined;
  const required = Array.isArray(input?.required) ? input.required.filter((entry): entry is string => typeof entry === 'string') : [];
  const description = typeof tool.description === 'string' ? tool.description : typeof tool.function?.description === 'string' ? tool.function.description : null;
  // The size cut never drops a required input: a job that cannot be given what it must have could never be asked for. The required
  // ones come first, then as many of the others as fit.
  // A schema may require a field it does not declare in its properties: it is still an input the job must be given
  const declared = allPropertyNames(input);
  const all = [...declared, ...required.filter((field) => !declared.includes(field))];
  const mustHave = all.filter((field) => required.includes(field));
  const rest = all.filter((field) => !required.includes(field)).slice(0, Math.max(0, MAX_SHAPE_FIELDS - mustHave.length));
  const kept = new Set([...mustHave, ...rest]);
  return {
    name,
    description: description ? description.slice(0, 300) : null,
    inputs: all.filter((field) => kept.has(field)).map((field) => ({ name: field, required: required.includes(field) })),
    outputs: propertyNames(tool.outputSchema),
  };
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
    if (message && typeof message === 'object' && !Array.isArray(message) && (message as { id?: unknown }).id === expectedId) {
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
    // A \r ends a line at once; a \n that follows it (in this chunk or the next) is the second half of \r\n and is dropped
    let afterCr = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        let piece = '';
        if (value) {
          read += value.byteLength;
          // The limit is kept before a chunk is decoded or split: a chunk that crosses it is not read at all
          if (read > MAX_STREAM_BYTES) break;
          piece = decoder.decode(value, { stream: true });
        }
        if (done) piece += decoder.decode();
        if (afterCr && piece.startsWith('\n')) {
          piece = piece.slice(1);
          afterCr = false;
        }
        if (piece) {
          afterCr = piece.endsWith('\r');
          buffer += normalizeNewlines(piece);
        }
        const frames = buffer.split('\n\n');
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
        buffer = tail;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error('No answer to the request found in the event stream');
  }

  // Read through the byte limit, not in full: an answer larger than it is refused, not parsed
  const text = await readBodyWithLimit(response, MAX_STREAM_BYTES + 1);
  if (Buffer.byteLength(text) > MAX_STREAM_BYTES) throw new Error('The answer of the app is larger than this check reads');
  // An event stream sent without its content type
  if (text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
    for (const frame of normalizeNewlines(text).split('\n\n')) {
      const answer = answerIn(frame, expectedId);
      if (answer) return answer;
    }
    throw new Error('No answer to the request found in the event stream');
  }
  // Fixed words for anything that is not the answer to this request: the body of a reply that is not JSON is never quoted back
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    throw new Error('The app did not answer in JSON');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || (message as { id?: unknown }).id !== expectedId) {
    throw new Error('The app did not answer this request');
  }
  return message as Record<string, unknown>;
}

/** The credentials this test sends: the sign-in and the values of the custom headers. Whatever an app sends back is cleaned of them before anything is read from it, kept or cut. */
type Secrets = readonly string[];

function withoutSecrets(text: string, secrets: Secrets): string {
  let out = text;
  // A secret with a quote, a backslash or a slash is written differently inside a JSON answer (\" \\ \/), so those spellings go too
  const spellings = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    const json = JSON.stringify(secret).slice(1, -1);
    spellings.add(secret);
    spellings.add(json);
    spellings.add(json.replace(/\//g, '\\/'));
  }
  // Longest first, so a secret that holds another is removed whole
  for (const spelling of [...spellings].sort((a, b) => b.length - a.length)) out = out.split(spelling).join('[removed]');
  return out;
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
  secrets: Secrets,
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
  const rawBody = withoutSecrets(responseBody ?? (await readBodyWithLimit(response)), secrets);
  // What is read out of the body is cleaned again: a secret written in JSON's own spelling is plain text once it is read out
  const readCode = extractErrorCode(rawBody);
  const errorCode = readCode === null ? null : withoutSecrets(readCode, secrets);
  // The reason phrase is chosen by the server, so it is stored text like any other and
  // goes through the same redact-then-truncate as the body and the challenge header: an
  // endpoint can echo credential material there, and it can be arbitrarily long. This
  // also sanitises the value embedded in `error`, which is what the panel displays.
  const statusText = truncateDetail(withoutSecrets(response.statusText, secrets)) || '';
  return {
    success: false,
    error: `HTTP ${response.status}${statusText ? `: ${statusText}` : ''}${errorCode ? ` \u2014 ${errorCode}` : ''}`,
    status: response.status,
    statusText,
    errorCode,
    // Redact-then-truncate, like the body: the stored field is documented as redacted
    // and, unlike the body, it previously had no length cap either.
    wwwAuthenticate: truncateDetail(withoutSecrets(response.headers.get('www-authenticate') ?? '', secrets) || null),
    errorBody: truncateDetail(rawBody),
  };
}

/** What a server's error answer says, redacted and cut like every other text a server sends back: it may echo the credentials it was sent. */
function rpcErrorText(error: unknown, secrets: Secrets): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  // The message is cleaned as it reads; the JSON of the whole error is cleaned in its own spelling (the secret's JSON form), then again as text
  const text = typeof message === 'string' && message ? message : withoutSecrets(JSON.stringify(error), secrets);
  return truncateDetail(withoutSecrets(text, secrets)) ?? 'unknown error';
}

/** Calls initialize and tools/list on an app's link with its stored sign-in (decrypted here only), through the same address guards at every hop. */
export async function testMcpConnection(server: { serverUrl: string; authType: string; authConfig: string | null; headers?: Record<string, string> | null }): Promise<{
  success: boolean;
  toolCount: number;
  toolNames: string[];
  /** What each tool takes and gives back, by field name (see McpToolShape). */
  tools?: McpToolShape[];
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
  const headers: Record<string, string> = { ...FIXED_HEADERS };
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

  const secrets: string[] = [authValue, ...Object.values(server.headers ?? {})].filter((value): value is string => typeof value === 'string' && value.length > 0);

  // Something saved earlier (or pasted before this check) with text that cannot be sent names the field, instead of the raw fetch error
  const unsendable = headerProblem({ authType: server.authType === 'oauth' ? 'bearer' : server.authType, authValue, headers: server.headers });
  if (unsendable) {
    return { success: false, toolCount: 0, toolNames: [], error: unsendable };
  }

  let session: { id: string; origin: string } | null = null;
  let protocolVersion: string | null = null;
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

    // The DNS-level guard is part of every request (pinnedFetch): the name is resolved once, the addresses are checked, and the connection
    // is made to the checked address, so a name that changes its answer between a check and the request reaches nothing internal

    // The headers a redirect gets: all of them on the same origin (an authenticated /mcp that redirects to /mcp/ still needs its
    // sign-in), only the two that carry no secret and no session on any other origin (prevents leaking bearer tokens, API keys,
    // session ids and custom credential headers such as a Cloudflare service token to a redirect target)
    // The two that go everywhere are the fixed protocol values, not whatever a custom header replaced them with
    function headersForRedirect(from: string, to: string, h: Record<string, string>): Record<string, string> {
      if (new URL(from).origin === new URL(to).origin) return { ...h };
      return { ...FIXED_HEADERS };
    }

    // The session id goes only to the origin that issued it (the origin the answer to the first request came from), the negotiated
    // protocol version to every request: it carries nothing secret
    function withSession(url: string, h: Record<string, string>): Record<string, string> {
      const out = { ...h };
      for (const key of Object.keys(out)) {
        if (key.toLowerCase() === 'mcp-session-id' || key.toLowerCase() === 'mcp-protocol-version') delete out[key];
      }
      if (protocolVersion) out['MCP-Protocol-Version'] = protocolVersion;
      if (session && new URL(url).origin === session.origin) out['Mcp-Session-Id'] = session.id;
      return out;
    }

    // Helper to follow a redirect manually with SSRF validation before each hop
    async function followRedirect(url: string, headers: Record<string, string>, body: string, redirectCount = 0): Promise<{ response: Response; url: string }> {
      if (redirectCount > 5) {
        throw new Error('Too many redirects');
      }
      // Validate redirect target before following (prevents redirect-based SSRF)
      if (!isAllowedServerUrl(url)) {
        throw new Error('Server redirected to an internal or private address');
      }
      const res = await pinnedFetch(url, {
        method: 'POST',
        headers: withSession(url, headers),
        body,
        signal: AbortSignal.timeout(10000),
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
      return { response: res, url };
    }

    // Helper to send a single MCP JSON-RPC POST request to the server URL,
    // handling redirects with SSRF-safe redirect validation.
    async function sendMcpRequest(body: string, expectedId: string | null): Promise<{
      success: boolean;
      data?: Record<string, unknown>;
      headers?: Record<string, string>;
      /** The address the answer came from: after a redirect, not the address that was asked. */
      from?: string;
      error?: string;
      status?: number;
      statusText?: string;
      errorCode?: string | null;
      wwwAuthenticate?: string | null;
      errorBody?: string | null;
    }> {
      const res = await pinnedFetch(server.serverUrl, {
        method: 'POST',
        headers: withSession(server.serverUrl, headers),
        body,
        signal: AbortSignal.timeout(10000),
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
        const reached = await followRedirect(redirectUrl, headersForRedirect(server.serverUrl, redirectUrl, headers), body).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Redirect failure';
          return { response: new Response(null, { status: 502, statusText: msg }), url: redirectUrl };
        });
        const followed = reached.response;
        if (!followed.ok) {
          return await describeFailure(followed, secrets);
        }
        const resHeaders: Record<string, string> = {};
        followed.headers.forEach((v: string, k: string) => { resHeaders[k] = v; });
        if (expectedId === null) await followed.body?.cancel().catch(() => undefined);
        return { success: true, data: expectedId === null ? {} : await parseMcpResponseBody(followed, expectedId), headers: resHeaders, from: reached.url };
      }

      if (!res.ok) {
        return await describeFailure(res, secrets);
      }

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v: string, k: string) => { resHeaders[k] = v; });
      if (expectedId === null) await res.body?.cancel().catch(() => undefined);
      return { success: true, data: expectedId === null ? {} : await parseMcpResponseBody(res, expectedId), headers: resHeaders, from: server.serverUrl };
    }

    // Step 1: Initialize MCP session (required by MCP Streamable HTTP spec)
    const initResult = await sendMcpRequest(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: REQUESTED_PROTOCOL_VERSION,
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
        error: `Initialize error: ${rpcErrorText(initResult.data.error, secrets)}`,
        ...failureFields(initResult),
      };
    }

    // Per MCP Streamable HTTP spec, session ID is transmitted in the Mcp-Session-Id HTTP response header, not in the JSON body.
    // Check header first, then fall back to body for non-spec servers. It belongs to the origin the answer came from.
    const initResultBody = initResult.data?.result && typeof initResult.data.result === 'object' ? (initResult.data.result as { sessionId?: unknown; protocolVersion?: unknown }) : undefined;
    const sessionId = initResult.headers?.['mcp-session-id'] || (typeof initResultBody?.sessionId === 'string' ? initResultBody.sessionId : undefined);
    if (sessionId) session = { id: sessionId, origin: new URL(initResult.from ?? server.serverUrl).origin };
    // The version the app chose, when it is one this check knows; else none is sent and the app applies its own default
    if (typeof initResultBody?.protocolVersion === 'string' && KNOWN_PROTOCOL_VERSIONS.has(initResultBody.protocolVersion)) protocolVersion = initResultBody.protocolVersion;

    // The session is open: the server is told so (a server may wait for this before it lists anything). Its answer is empty
    // (202); one that refuses it is left to the list below, which shows any real refusal.
    await sendMcpRequest(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), null).catch(() => undefined);

    // Step 2: Call tools/list, every page of it
    const toolNames: string[] = [];
    const shapes: McpToolShape[] = [];
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
          error: `MCP error: ${rpcErrorText(data.error, secrets)}`,
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
          shapes.push(shapeOfTool(tool, named));
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
      tools: shapes,
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
      error: typeof err.message === 'string' ? truncateDetail(withoutSecrets(err.message, secrets)) ?? 'Connection failed' : 'Connection failed',
    };
  } finally {
    // The session that was opened is closed, so an app that keeps sessions until they expire does not keep one for every test. A short
    // try, sent only to the origin that issued it, with the sign-in only because that origin is the one the app was configured with.
    if (session && new URL(server.serverUrl).origin === session.origin) {
      const closing = { ...headers, 'Mcp-Session-Id': session.id, ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) };
      await pinnedFetch(server.serverUrl, { method: 'DELETE', headers: closing, signal: AbortSignal.timeout(3000) }).then((res) => res.body?.cancel().catch(() => undefined), () => undefined);
    }
  }
}
