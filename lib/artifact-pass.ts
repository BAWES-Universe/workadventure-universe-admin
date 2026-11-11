import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ArtifactError, fileTypeOf, type ArtifactKind } from '@/lib/artifacts';
import { getPlayOrigin } from '@/lib/origin-policy';

/**
 * "Just you" (game #1994): how the files of a private artifact reach its owner and nobody else.
 *
 * Every other artifact is served from the bucket's own address, which anyone who has it can open. A private one is not:
 * its files sit at addresses nobody was given (lib/artifact-service.ts moves them there), and Orbit serves them itself, at
 * /af/<pass>/<version>/<name>. A pass is one opening by the owner. It is made only by a route that has checked who is
 * asking, it stops with the artifact, and on every request Orbit checks again that its person still owns the artifact.
 *
 * The page (or drawing) is served to the first browser that asks, with a cookie that only that address reads. After that
 * the page needs the cookie, so an address passed on to someone else opens nothing. The songs, images and videos beside
 * a page need only the pass: a locked page asks for some of them without cookies (`crossorigin`), and not every browser
 * sends a cookie from a locked frame. They are served once the page has been, and only while the pass lasts.
 */

/** How long one opening lasts, in minutes. A page left open longer is opened again. ARTIFACT_PASS_MINUTES changes it. */
const DEFAULT_PASS_MINUTES = 12 * 60;

export function passLifeMs(): number {
  const minutes = Number(process.env.ARTIFACT_PASS_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_PASS_MINUTES) * 60_000;
}

/** The random part of an address, and of the cookie: 256 bits, in letters a path and a cookie can hold. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** What is kept of a secret: its SHA-256. The secret itself is never stored, so the table opens nothing by itself. */
export function hashOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Only what newSecret makes is looked up at all. */
export function looksLikeSecret(value: string | undefined | null): value is string {
  return typeof value === 'string' && SECRET.test(value);
}

/**
 * Orbit's own address, as a browser reaches it (the same setting sign-in uses). Private files are served from it, so
 * without it nothing can be made private: the answer is 503 and the artifact stays as it was.
 */
export function orbitAddress(): string {
  const configured = (process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(configured)) {
    throw new ArtifactError('private_files_not_configured', 503, 'Orbit does not know its own address (NEXT_PUBLIC_API_URL), so it cannot serve a private artifact.');
  }
  return configured;
}

/** The folder one version of a private artifact is served from; the page names its media beside it, as in the bucket. */
export function passFolder(token: string, number: number): string {
  return `/af/${token}/${number}/`;
}

/** The folder one version's files are served from for this pass, as a browser reaches it: the page and what is beside it. */
export function passFolderAddress(token: string, number: number): string {
  return `${orbitAddress()}${passFolder(token, number)}`;
}

/** Where the page (or drawing) of one version is served for this pass. */
export function passAddress(token: string, number: number, kind: ArtifactKind): string {
  return `${passFolderAddress(token, number)}index.${fileTypeOf(kind).extension}`;
}

/** The cookie of one pass: its name says nothing, and only this pass's addresses ever see it. */
export function passCookieName(tokenHash: string): string {
  return `af_${tokenHash.slice(0, 12)}`;
}

/**
 * The cookie that ties a pass to the browser that opened it. Over https it must be SameSite=None: what a locked frame
 * loads counts as coming from another site. Plain http (a developer's machine) cannot set that, so it gets Lax there.
 * Not "Partitioned": the game and Orbit share a site, and a partitioned cookie set by the page's own answer is not sent
 * back from inside the locked frame.
 */
export function passCookie(token: string, tokenHash: string, value: string, maxAgeSeconds: number): string {
  const secure = orbitAddress().toLowerCase().startsWith('https://');
  return [
    `${passCookieName(tokenHash)}=${value}`,
    `Path=/af/${token}/`,
    `Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    secure ? 'Secure; SameSite=None' : 'SameSite=Lax',
  ].join('; ');
}

/** The value of one cookie from a Cookie header, or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * What a private page is sent with: the lock the bucket's address puts on every artifact (it runs, but with no origin of
 * its own, no network except the common libraries, and no forms), and it can be framed only by the game and by Orbit.
 *
 * One line is tighter than the bucket's. There a page's pictures, songs and videos come from `'self'`, an address that
 * holds nothing but artifacts. Here `'self'` would be all of Orbit, so they come from `mediaFolder` only: this pass's own
 * folder for this version (`passFolderAddress`). A page cannot ask Orbit for anything else, not even as a picture.
 */
export function pagePolicy(mediaFolder: string): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com data:',
    `img-src ${mediaFolder} data: blob:`,
    `media-src ${mediaFolder} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self' ${getPlayOrigin()}`,
  ].join('; ');
}

/** A drawing never runs anything, wherever it is opened. */
export function drawingPolicy(): string {
  return ["sandbox", "default-src 'none'", "style-src 'unsafe-inline'", "img-src data:", `frame-ancestors 'self' ${getPlayOrigin()}`].join('; ');
}

/** A song, image or video opened on its own is only ever that: nothing in it runs. */
export const MEDIA_POLICY = "sandbox; default-src 'none'";

/**
 * Lets a locked page read what it shows and plays, not only show it: draw its picture on a canvas and read it back, or
 * analyse its song (`<img crossorigin>`, `<audio crossorigin>`). A locked page has no origin of its own, so there is no
 * origin to name, and to it even its own files come from "elsewhere".
 *
 * The one place Orbit answers `*` (__tests__/lib/cors.test.ts keeps it the only one). It gives nothing away: a song,
 * image or video of a private artifact is protected by the pass in its address and asks for no cookie, so whoever holds
 * the address can already fetch the file without a browser, and a browser never sends a cookie with a read `*` allows.
 * Never on the page itself, and never on any route that reads a sign-in.
 */
export const MEDIA_READ_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } as const;

/**
 * A page runs scripts, so it is never shown as a page of Orbit's own: only inside a frame. Every current browser says what
 * a request is for (Sec-Fetch-Dest); one that says "document" is someone opening the address in a tab, and is turned
 * away. An old browser says nothing, and the lock above still holds there.
 */
export function mayShowPage(fetchDest: string | null | undefined): boolean {
  return !fetchDest || fetchDest === 'iframe' || fetchDest === 'frame';
}

/** One part of a file: `bytes=0-99`, `bytes=100-` or `bytes=-100`, as a player asks while it seeks. Null when it asks for none. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (size <= 0) return 'unsatisfiable';
  if (match[1] === '') {
    const last = Number(match[2]);
    if (!Number.isSafeInteger(last) || last <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
