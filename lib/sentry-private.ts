/**
 * The address of a private artifact's file holds its pass (game #1994, lib/artifact-pass.ts), so nothing about a request
 * for one is traced, and an error that happens while serving one is sent without the pass.
 */
// Not the route's own name ("/af/[token]/..."): that is no pass, and an error's file names and its group keep it as it is
const PRIVATE_FILE = /\/af\/(?!\[)[^/?#\s]+/g;

function holdsPrivateAddress(value: unknown): boolean {
  return typeof value === 'string' && /\/af\//.test(value);
}

/** Is this trace about a request for a private artifact's file? */
export function isPrivateFileTrace(context: { name?: string; attributes?: Record<string, unknown>; normalizedRequest?: { url?: string } }): boolean {
  if (holdsPrivateAddress(context.name) || holdsPrivateAddress(context.normalizedRequest?.url)) return true;
  return Object.values(context.attributes ?? {}).some(holdsPrivateAddress);
}

/** The sampler for Sentry.init: never a private file's request, everything else at the usual rate. */
export function tracesSamplerAt(rate: number) {
  return (context: { name?: string; attributes?: Record<string, unknown>; normalizedRequest?: { url?: string }; inheritOrSampleWith: (fallback: number) => number }): number =>
    isPrivateFileTrace(context) ? 0 : context.inheritOrSampleWith(rate);
}

/** The same text with every pass taken out. */
export function withoutPass(value: string): string {
  return value.replace(PRIVATE_FILE, '/af/[pass]');
}

/** How deep an event is read. Sentry's own events are a few levels deep; this only keeps a strange one from running on. */
const MAX_DEPTH = 12;

function scrub(holder: Record<string, unknown> | unknown[], depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_DEPTH || seen.has(holder)) return;
  seen.add(holder);
  const entries: [string | number, unknown][] = Array.isArray(holder) ? holder.map((value, index) => [index, value]) : Object.entries(holder);
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      if (holdsPrivateAddress(value)) (holder as Record<string | number, unknown>)[key] = withoutPass(value);
    } else if (value !== null && typeof value === 'object') {
      scrub(value as Record<string, unknown> | unknown[], depth + 1, seen);
    }
  }
}

/**
 * For Sentry's beforeSend: the event with the pass taken out, wherever it is written.
 *
 * Not only its address and its name. Next.js reports a failure outside the route's own code through
 * Sentry.captureRequestError (instrumentation.ts), which writes the path it was asked for into
 * `contexts.nextjs.request_path`; a media file's request names the page in its Referer header; and an error's own text
 * can quote either. Every text in the event is read, so a field the SDK adds later is covered too.
 */
export function scrubPrivateAddress<E extends object>(event: E): E {
  scrub(event as Record<string, unknown>, 0, new WeakSet());
  return event;
}
