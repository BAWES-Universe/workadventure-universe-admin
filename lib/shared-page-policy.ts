/**
 * The Content-Security-Policy of the shared page (/a/:id): never framed itself, and the frames it holds are only its own
 * (a document's, drawn from its text) or the address the artifacts' files are served from. A document that somehow sent
 * its frame elsewhere is stopped by this too. It is read when a request comes in (middleware), not when Orbit is built, so
 * it follows the address the running server is given.
 */
export function sharedPagePolicy(artifactsPublicUrl: string | undefined = process.env.ARTIFACTS_PUBLIC_URL): string {
  let origin: string | undefined;
  try {
    origin = artifactsPublicUrl ? new URL(artifactsPublicUrl).origin : undefined;
  } catch {
    origin = undefined;
  }
  return `frame-ancestors 'none'; frame-src ${["'self'", origin].filter(Boolean).join(' ')};`;
}
