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
export const ORBIT_BRIDGE_CAPABILITIES = ['navigate', 'event', 'view', 'quests'] as const;

/** Pages the game may ask for. Anything else lands on Orbit's home. */
export const ORBIT_NAVIGATE_INTENTS = ['new-universe', 'world-members', 'visit-card', 'quest'] as const;

/**
 * The two sizes of Orbit's window inside the game: the compact companion panel (the default) and the full-screen
 * view for bigger tasks. The game owns the size (its own maximise button) and tells Orbit (`orbit-view`).
 */
export const ORBIT_VIEWS = ['compact', 'full'] as const;
export type OrbitView = (typeof ORBIT_VIEWS)[number];
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
  // Which view the frame is in right now; an older game doesn't say, and the compact view is assumed.
  view: z.enum(ORBIT_VIEWS).optional(),
  // The longest name the game accepts (a game that can take a new name says "profile" in its capabilities).
  maxNameLength: z.number().int().min(1).max(128).optional(),
});

export const orbitViewSchema = z.object({
  type: z.literal('orbit-view'),
  version: z.literal(ORBIT_BRIDGE_VERSION),
  view: z.enum(ORBIT_VIEWS),
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
/**
 * The player's quest log, from a game that offers quests (the proof slice): what You shows under Quests. Display
 * only, bounded, and replaced whole by the next one; nothing in it is stored on the server.
 */
export const ORBIT_QUEST_STATUSES = ['tracked', 'accepted', 'done'] as const;
export const ORBIT_QUEST_STAMPS = ['first-hello', 'explorer', 'builder'] as const;
export const orbitQuestEntrySchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  status: z.enum(ORBIT_QUEST_STATUSES),
  stamp: z.enum(ORBIT_QUEST_STAMPS).optional(),
  giver: z.string().min(1).max(64).optional(),
  room: z.string().max(80),
  // What to do, in the game's words ("Find the Courtyard"); older games don't send it.
  objective: z.string().min(1).max(120).optional(),
});
export const orbitQuestStateSchema = z.object({
  type: z.literal('orbit-quest-state'),
  version: z.literal(ORBIT_BRIDGE_VERSION),
  // The game sends {type, version, entries}; a revision, when present, must be the current one.
  roomRevision: roomRevision.optional(),
  entries: z.array(orbitQuestEntrySchema).max(8),
});

export type OrbitEvent = z.infer<typeof orbitEventSchema>;
export type OrbitQuestEntry = z.infer<typeof orbitQuestEntrySchema>;
export type OrbitQuestState = z.infer<typeof orbitQuestStateSchema>;
export type OrbitViewChange = z.infer<typeof orbitViewSchema>;

export type OrbitBridgeAckError = 'stale-revision' | 'not-ready';

export interface OrbitBridgeReady {
  type: 'orbit-bridge-ready';
  version: typeof ORBIT_BRIDGE_VERSION;
  capabilities: readonly string[];
}

/** You saved a new name in your profile: the game shows it once Orbit closes (needs the game's "profile"). */
export interface OrbitProfileChanged {
  type: 'orbit-profile-changed';
  version: typeof ORBIT_BRIDGE_VERSION;
  roomRevision: string;
  name: string;
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
  | { kind: 'event'; message: OrbitEvent }
  | { kind: 'view'; message: OrbitViewChange }
  | { kind: 'quest-state'; message: OrbitQuestState };

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
  const view = orbitViewSchema.safeParse(event.data);
  if (view.success) return { kind: 'view', message: view.data };
  const questState = orbitQuestStateSchema.safeParse(event.data);
  if (questState.success) return { kind: 'quest-state', message: questState.data };
  return null;
}

export function isKnownIntent(intent: string): intent is OrbitNavigateIntent {
  return (ORBIT_NAVIGATE_INTENTS as readonly string[]).includes(intent);
}
