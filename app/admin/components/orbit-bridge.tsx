'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/client-auth';
import { PLAY_ORIGIN, isInsideFrame } from '@/lib/play-origin';
import { questsProofEnabled } from '@/lib/quests/flag';
import { setQuestLog } from '@/lib/quests/quest-log';
import {
  ORBIT_BRIDGE_CAPABILITIES,
  ORBIT_BRIDGE_VERSION,
  ORBIT_HOME_PATH,
  parseBridgeMessage,
  type OrbitBridgeAck,
  type OrbitBridgeAckError,
  type OrbitBridgeReady,
  type OrbitEventTopic,
  type OrbitProfileChanged,
  type OrbitView,
} from '@/lib/orbit-bridge';

/** Fired on `window` when the game says something changed, for pages that keep their own data. */
export const ORBIT_REFRESH_EVENT = 'orbit:refresh';
export type OrbitRefreshEventDetail = { topic: OrbitEventTopic };

/** What the game said about this visit (in `orbit-bridge-init`), for the one thing Orbit tells the game. */
let gameVisit: { roomRevision: string; capabilities: string[]; maxNameLength?: number } | null = null;

/** The longest name the game accepts, when Orbit is open in a game that can take a new name. */
export function gameMaxNameLength(): number | undefined {
  return gameVisit?.capabilities.includes('profile') ? gameVisit.maxNameLength : undefined;
}

/**
 * Tells the game you saved a new name, so it shows it once Orbit closes. Returns false outside the game, or in a
 * game that can't take one (the name then shows the next time the game loads).
 */
export function announceProfileName(name: string): boolean {
  if (!gameVisit?.capabilities.includes('profile') || !isInsideFrame()) return false;
  const message: OrbitProfileChanged = {
    type: 'orbit-profile-changed',
    version: ORBIT_BRIDGE_VERSION,
    roomRevision: gameVisit.roomRevision,
    name,
  };
  window.parent.postMessage(message, PLAY_ORIGIN);
  return true;
}

async function resolvePage(intent: string, params: Record<string, string> | undefined): Promise<string> {
  try {
    const response = await authenticatedFetch('/api/orbit-bridge/resolve', {
      method: 'POST',
      body: JSON.stringify({ intent, params }),
    });
    if (!response.ok) return ORBIT_HOME_PATH;
    const data = (await response.json()) as { path?: unknown };
    return typeof data.path === 'string' && data.path.startsWith('/admin') ? data.path : ORBIT_HOME_PATH;
  } catch {
    return ORBIT_HOME_PATH;
  }
}

/**
 * Orbit's end of the bridge (see lib/orbit-bridge.ts). Mounted by the shell once the session is loaded, so it only
 * says it is ready (and so only receives page requests) after sign-in has completed.
 */
export default function OrbitBridge({
  onRefresh,
  onView,
}: {
  onRefresh: () => void;
  /** The game said which view (compact or full-screen) its frame is in. */
  onView?: (view: OrbitView) => void;
}) {
  const router = useRouter();
  const roomRevision = useRef<string | null>(null);
  const onRefreshRef = useRef(onRefresh);
  const onViewRef = useRef(onView);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    onViewRef.current = onView;
  }, [onRefresh, onView]);

  useEffect(() => {
    if (!isInsideFrame()) return;
    const post = (message: OrbitBridgeReady | OrbitBridgeAck) => window.parent.postMessage(message, PLAY_ORIGIN);
    const ack = (requestId: string, revision: string, error?: OrbitBridgeAckError) =>
      post({
        type: 'orbit-bridge-ack',
        version: ORBIT_BRIDGE_VERSION,
        requestId,
        roomRevision: revision,
        ok: !error,
        ...(error ? { error } : {}),
      });

    const onMessage = (event: MessageEvent<unknown>) => {
      const parsed = parseBridgeMessage(event, { origin: PLAY_ORIGIN, source: window.parent });
      if (!parsed) return;

      if (parsed.kind === 'init') {
        roomRevision.current = parsed.message.roomRevision;
        gameVisit = {
          roomRevision: parsed.message.roomRevision,
          capabilities: parsed.message.capabilities,
          maxNameLength: parsed.message.maxNameLength,
        };
        if (parsed.message.view) onViewRef.current?.(parsed.message.view);
        return;
      }

      if (parsed.kind === 'view') {
        onViewRef.current?.(parsed.message.view);
        return;
      }

      // Display only: shown on You while the proof slice is on, never answered (it isn't a request).
      if (parsed.kind === 'quest-state') {
        const { roomRevision: revision, entries } = parsed.message;
        const current = roomRevision.current !== null && (revision === undefined || revision === roomRevision.current);
        if (questsProofEnabled() && current) setQuestLog(entries);
        return;
      }

      const { requestId, roomRevision: revision } = parsed.message;
      if (roomRevision.current === null) return ack(requestId, revision, 'not-ready');
      // A request from an earlier room or connection is refused.
      if (revision !== roomRevision.current) return ack(requestId, revision, 'stale-revision');

      if (parsed.kind === 'navigate') {
        const { intent, params } = parsed.message;
        void resolvePage(intent, params).then((path) => {
          // The room may have changed while Orbit was resolving the page.
          if (roomRevision.current !== revision) return ack(requestId, revision, 'stale-revision');
          router.push(path);
          ack(requestId, revision);
        });
        return;
      }

      // A refresh hint only: fetch again, trust nothing in the message.
      const detail: OrbitRefreshEventDetail = { topic: parsed.message.topic };
      onRefreshRef.current();
      router.refresh();
      window.dispatchEvent(new CustomEvent(ORBIT_REFRESH_EVENT, { detail }));
      ack(requestId, revision);
    };

    window.addEventListener('message', onMessage);
    // The game sends its quest log only to an Orbit that asks for it.
    const capabilities = questsProofEnabled() ? [...ORBIT_BRIDGE_CAPABILITIES, 'quests'] : ORBIT_BRIDGE_CAPABILITIES;
    post({ type: 'orbit-bridge-ready', version: ORBIT_BRIDGE_VERSION, capabilities });
    return () => {
      window.removeEventListener('message', onMessage);
      gameVisit = null;
    };
  }, [router]);

  return null;
}
