import { z } from 'zod';

/**
 * The Orbit bridge: the messages the game and Orbit exchange after the sign-in handshake (`orbit-auth-*-v2`).
 *
 * The game uses it to tell Orbit which page to show (`orbit-navigate`) and when something changed (`orbit-event`,
 * a refresh hint only). No message is ever proof of anything: every page is resolved and authorised by Orbit's own
 * server. Orbit's actions on the game (closing, visiting a room) stay on the WorkAdventure scripting API (`WA.*`),
 * so the bridge has no message for them.
 *
 * Both sides check the exact origin and window, the version and the shape of every message, and ignore anything
 * they do not know, so an older game and a newer Orbit (and the reverse) keep working. Every request carries the
 * game's room revision (new on each room join or reconnect); one from an earlier revision is refused.
 */
export const ORBIT_BRIDGE_VERSION = 1 as const;

/** What this Orbit can do over the bridge (sent in `orbit-bridge-ready`). */
export const ORBIT_BRIDGE_CAPABILITIES = ['navigate', 'event'] as const;

/** Pages the game may ask for. Anything else lands on Orbit's home. */
export const ORBIT_NAVIGATE_INTENTS = ['new-universe', 'world-members'] as const;
export type OrbitNavigateIntent = (typeof ORBIT_NAVIGATE_INTENTS)[number];

/** What changed, for a refresh hint. */
export const ORBIT_EVENT_TOPICS = ['all', 'universes', 'worlds', 'rooms', 'profile', 'memberships'] as const;
export type OrbitEventTopic = (typeof ORBIT_EVENT_TOPICS)[number];

export const ORBIT_HOME_PATH = '/admin';

const roomRevision = z.string().min(16).max(128);
const requestId = z.string().min(1).max(64);

export const orbitBridgeInitSchema = z.object({
  type: z.literal('orbit-bridge-init'),
  version: z.literal(ORBIT_BRIDGE_VERSION),
  roomRevision,
  capabilities: z.array(z.string().max(32)).max(16),
});

export const orbitNavigateSchema = z.object({
  type: z.literal('orbit-navigate'),
  version: z.literal(ORBIT_BRIDGE_VERSION),
  requestId,
  roomRevision,
  // Kept as a string here so an intent this Orbit does not know still gets an answer (home), not silence.
  intent: z.string().min(1).max(64),
  params: z.record(z.string().max(64), z.string().max(256)).optional(),
});

export const orbitEventSchema = z.object({
  type: z.literal('orbit-event'),
  version: z.literal(ORBIT_BRIDGE_VERSION),
  requestId,
  roomRevision,
  topic: z.enum(ORBIT_EVENT_TOPICS),
});

export type OrbitBridgeInit = z.infer<typeof orbitBridgeInitSchema>;
export type OrbitNavigate = z.infer<typeof orbitNavigateSchema>;
export type OrbitEvent = z.infer<typeof orbitEventSchema>;

export type OrbitBridgeAckError = 'stale-revision' | 'not-ready';

export interface OrbitBridgeReady {
  type: 'orbit-bridge-ready';
  version: typeof ORBIT_BRIDGE_VERSION;
  capabilities: readonly string[];
}

export interface OrbitBridgeAck {
  type: 'orbit-bridge-ack';
  version: typeof ORBIT_BRIDGE_VERSION;
  requestId: string;
  roomRevision: string;
  ok: boolean;
  error?: OrbitBridgeAckError;
}

export type IncomingBridgeMessage =
  | { kind: 'init'; message: OrbitBridgeInit }
  | { kind: 'navigate'; message: OrbitNavigate }
  | { kind: 'event'; message: OrbitEvent };

/**
 * Accept a message only from the game: exact origin, the parent window, and a known, well-formed message.
 * Anything else (another origin or window, another version, a malformed or unknown message) is ignored.
 */
export function parseBridgeMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; source: unknown },
): IncomingBridgeMessage | null {
  if (event.origin !== expected.origin || event.source !== expected.source) return null;
  const init = orbitBridgeInitSchema.safeParse(event.data);
  if (init.success) return { kind: 'init', message: init.data };
  const navigate = orbitNavigateSchema.safeParse(event.data);
  if (navigate.success) return { kind: 'navigate', message: navigate.data };
  const orbitEvent = orbitEventSchema.safeParse(event.data);
  if (orbitEvent.success) return { kind: 'event', message: orbitEvent.data };
  return null;
}

export function isKnownIntent(intent: string): intent is OrbitNavigateIntent {
  return (ORBIT_NAVIGATE_INTENTS as readonly string[]).includes(intent);
}

// Remembered page: the last page Orbit showed during this visit, so reopening Orbit lands there. A page the game
// asks for (an `orbit-navigate`, or the login URL's `redirect`) beats it; a room change or reconnect (a new room
// revision) and an account change (every sessionStorage entry is purged) clear it.

export const REMEMBERED_PAGE_KEY = 'orbit_bridge_remembered_page';

interface RememberedPage {
  roomRevision: string;
  path: string;
}

/** Only Orbit's own pages, never the login page. */
export function isRememberablePath(path: string): boolean {
  return (path === ORBIT_HOME_PATH || path.startsWith(`${ORBIT_HOME_PATH}/`)) && !path.startsWith('/admin/login');
}

export function rememberPage(storage: Storage, roomRevision: string, path: string): void {
  if (!isRememberablePath(path)) return;
  const value: RememberedPage = { roomRevision, path };
  storage.setItem(REMEMBERED_PAGE_KEY, JSON.stringify(value));
}

export function forgetRememberedPage(storage: Storage): void {
  storage.removeItem(REMEMBERED_PAGE_KEY);
}

/** The remembered page for this room revision, or null (none, another revision, or not a page Orbit remembers). */
export function rememberedPageFor(storage: Storage, roomRevision: string | null): string | null {
  if (!roomRevision) return null;
  const raw = storage.getItem(REMEMBERED_PAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RememberedPage>;
    if (value.roomRevision !== roomRevision || typeof value.path !== 'string' || !isRememberablePath(value.path)) {
      return null;
    }
    return value.path;
  } catch {
    return null;
  }
}

/** The room revision the game put on the login URL (`rev`), when it looks like one. */
export function roomRevisionFromUrl(url: URL): string | null {
  const value = url.searchParams.get('rev');
  return roomRevision.safeParse(value).success ? value : null;
}
