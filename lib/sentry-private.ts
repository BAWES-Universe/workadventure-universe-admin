/**
 * The address of a private artifact's file holds its pass (game #1994, lib/artifact-pass.ts), so nothing about a request
 * for one is traced, and an error that happens while serving one is sent without the pass.
 */
const PRIVATE_FILE = /\/af\/[^/?#\s]+/g;

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

/** For Sentry's beforeSend: the event with the pass taken out of its address and its name. */
export function scrubPrivateAddress<E extends { request?: { url?: string }; transaction?: string }>(event: E): E {
  if (event.request?.url) event.request.url = withoutPass(event.request.url);
  if (event.transaction) event.transaction = withoutPass(event.transaction);
  return event;
}
