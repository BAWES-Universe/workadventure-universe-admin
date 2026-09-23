/**
 * Presentation + sanitisation helpers for stored MCP connection test results (#186).
 *
 * Two problems this solves:
 *
 * 1. The test route used to store only `HTTP <status>: <statusText>`, discarding
 *    the response body (which carries the error code) and the `WWW-Authenticate`
 *    header (which points at the resource-metadata document that explains the
 *    rejection). Those two were the entire diagnosis for the 401 that started
 *    this. They are now stored — and anything stored is redacted here, so a
 *    future server that echoes credentials back cannot leak them into the panel.
 * 2. A stored result was rendered with no indication of when it was taken, so a
 *    connection that died weeks ago kept showing a green "Connected" badge.
 *
 * Both functions are pure so they can be unit-tested without a database or a
 * browser, and `summarizeTestResult` tolerates results written before these
 * fields existed (every new field is optional).
 */

/** Shape stored in `BotMcpServer.lastTestResult`. */
export interface McpTestResult {
  success: boolean;
  toolCount: number;
  toolNames: string[];
  error?: string | null;
  /** Captured from the failure path; absent on results stored before #186. */
  status?: number | null;
  statusText?: string | null;
  /** Error code extracted from the response body, e.g. `invalid_token`. */
  errorCode?: string | null;
  /** `WWW-Authenticate` header from the failing response, redacted. */
  wwwAuthenticate?: string | null;
  /** Redacted, truncated response body from the failing response. */
  errorBody?: string | null;
}

export type TestResultTone = 'ok' | 'stale' | 'error' | 'none';

export interface TestResultSummary {
  tone: TestResultTone;
  /** Primary line shown in the table cell. */
  label: string;
  /** Secondary line: age, error code, header. Absent when there is nothing to add. */
  detail?: string;
}

/** Cap on any stored free text, so one hostile response cannot bloat a row. */
export const MAX_DETAIL_LENGTH = 300;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
// A bearer value is a credential; `Bearer resource_metadata="…"` / `Bearer error=…`
// are RFC 6750 challenge parameters and carry none, so they are left readable —
// the WWW-Authenticate header is precisely what we want to store and show.
const BEARER_PATTERN = /(bearer\s+)(?!resource_metadata|[a-z_]+[a-z]=)([A-Za-z0-9._~+/=-]{8,})/gi;
const JSON_SECRET_PATTERN =
  /((?:"|')?(?:access_token|refresh_token|id_token|client_secret|api[_-]?key|token)(?:"|')?\s*[:=]\s*(?:"|'))([^"']{4,})(?:"|')/gi;
const QUERY_SECRET_PATTERN =
  /((?:access_token|refresh_token|id_token|client_secret|api[_-]?key|token)=)([^&\s"']{4,})/gi;

/**
 * Remove credential-shaped material from text that is about to be stored and
 * shown in a UI. Deliberately belt-and-braces: `WWW-Authenticate` and error
 * bodies carry no credentials on the servers configured today, but that is a
 * property of those servers, not a guarantee.
 */
export function redactCredentialMaterial(text: string): string {
  if (!text) return '';
  return text
    .replace(JWT_PATTERN, '[redacted-jwt]')
    .replace(BEARER_PATTERN, '$1[redacted]')
    .replace(JSON_SECRET_PATTERN, '$1[redacted]')
    .replace(QUERY_SECRET_PATTERN, '$1[redacted]');
}

/** Redact, then truncate — in that order, so a clipped secret is still redacted. */
export function truncateDetail(text: string | null | undefined, limit = MAX_DETAIL_LENGTH): string | null {
  if (!text) return null;
  const redacted = redactCredentialMaterial(text);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

/**
 * Cap on how much of a failing server's response body is read at all (#186 review).
 *
 * `truncateDetail` caps what is *stored*; this caps what is *read*, so a broken or
 * hostile endpoint that streams megabytes cannot be buffered in memory first. The
 * request timeout bounds how long we wait, not how much arrives.
 */
export const MAX_ERROR_BODY_BYTES = 8 * 1024;

/**
 * Read at most `maxBytes` of a response body, then cancel the stream.
 *
 * Only for failure paths, where the body is wanted for its error code and nothing
 * else. Success paths still read the whole body: the JSON-RPC / SSE payload has to be
 * parsed, and a tool list is legitimately large.
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number = MAX_ERROR_BODY_BYTES
): Promise<string> {
  const stream = response.body;
  if (!stream) return '';

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - total;
      chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.length, remaining);
    }
  } catch {
    // A stream that dies mid-read still yields what arrived before it did; the caller
    // redacts and truncates whatever comes back.
  } finally {
    // Stop the transfer rather than letting the rest of the body drain.
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Pull the most useful error identifier out of a failing response body.
 * Handles the shapes seen in practice — `{"error":"invalid_token"}`,
 * `{"statusCode":401,"error":"Unauthorized","message":"…"}` — and falls back to
 * the raw text when the body is not JSON.
 */
export function extractErrorCode(rawBody: string | null | undefined): string | null {
  if (!rawBody) return null;
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>;
      const nestedError = body.error;
      const candidates: unknown[] = [
        typeof nestedError === 'string' ? nestedError : undefined,
        nestedError && typeof nestedError === 'object'
          ? (nestedError as Record<string, unknown>).message
          : undefined,
        body.error_description,
        body.message,
        typeof body.statusCode === 'number' ? String(body.statusCode) : undefined,
      ];
      const found = candidates.find((c) => typeof c === 'string' && c.trim().length > 0);
      if (typeof found === 'string') return truncateDetail(found, 120);
      return truncateDetail(trimmed, 120);
    }
    if (typeof parsed === 'string' && parsed.trim()) return truncateDetail(parsed, 120);
  } catch {
    // Not JSON — fall through to the raw text.
  }

  return truncateDetail(trimmed, 120);
}

/** Human age of a stored result. Pure: `now` is injected for testability. */
export function formatResultAge(testedAt: Date | null | undefined, now: Date): string | null {
  if (!testedAt || Number.isNaN(testedAt.getTime())) return null;

  const seconds = Math.floor((now.getTime() - testedAt.getTime()) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 90) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function shortTimestamp(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

/**
 * Decide how a stored result should be presented.
 *
 * A connection whose stored access token has expired is never shown as plainly
 * green, however green the stored result is: that is exactly the illusion that
 * let four dead connections look healthy for two months.
 *
 * `reconnectRequired` is the connection's own verdict, when the caller has it. `true`
 * means only a human can fix it, whatever the expiry says: a recorded verdict clears
 * the stored expiry, so the expiry alone cannot show it. `false` means the connection
 * can still renew itself, so an expired token is flagged without asking a human to act.
 * Left out, an expired token keeps the original re-authorize wording.
 */
export function summarizeTestResult(
  result: McpTestResult | null | undefined,
  opts: {
    testedAt?: string | Date | null;
    oauthExpiresAt?: string | null;
    reconnectRequired?: boolean;
    now?: Date;
  } = {}
): TestResultSummary {
  const now = opts.now ?? new Date();
  if (!result) return { tone: 'none', label: 'Not tested' };

  const testedAt = opts.testedAt ? new Date(opts.testedAt) : null;
  const age = formatResultAge(testedAt, now);
  const expiry = opts.oauthExpiresAt ? new Date(opts.oauthExpiresAt) : null;
  const tokenExpired = expiry !== null && !Number.isNaN(expiry.getTime()) && expiry.getTime() <= now.getTime();

  if (result.success) {
    const label = `Connected — ${result.toolCount} tool${result.toolCount !== 1 ? 's' : ''}`;
    const lastTested = age ? ` (last tested ${age})` : '';
    if (opts.reconnectRequired === true) {
      return {
        tone: 'stale',
        label,
        detail: `${tokenExpired ? `token expired ${shortTimestamp(expiry!)}` : 'reconnect required'} — re-authorize to reconnect${lastTested}`,
      };
    }
    if (tokenExpired) {
      return {
        tone: 'stale',
        label,
        detail:
          opts.reconnectRequired === false
            ? `token expired ${shortTimestamp(expiry!)} — renewed automatically on next use${lastTested}`
            : `token expired ${shortTimestamp(expiry!)} — re-authorize to reconnect${lastTested}`,
      };
    }
    return { tone: 'ok', label, detail: age ? `tested ${age}` : undefined };
  }

  const parts: string[] = [];
  if (age) parts.push(`tested ${age}`);
  if (typeof result.status === 'number') {
    parts.push(`${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
  }
  if (result.errorCode) parts.push(`error: ${result.errorCode}`);
  if (result.wwwAuthenticate) parts.push(result.wwwAuthenticate);

  return {
    tone: 'error',
    label: result.error || 'Failed',
    detail: parts.length > 0 ? parts.join(' · ') : undefined,
  };
}
