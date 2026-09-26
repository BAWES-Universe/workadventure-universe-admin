'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { authenticatedFetch } from '@/lib/client-auth';
import { PLAY_ORIGIN, isInsideFrame } from '@/lib/play-origin';
import {
  ORBIT_BRIDGE_CAPABILITIES,
  ORBIT_BRIDGE_VERSION,
  ORBIT_HOME_PATH,
  parseBridgeMessage,
  type OrbitBridgeAck,
  type OrbitBridgeAckError,
  type OrbitBridgeReady,
  type OrbitEventTopic,
} from '@/lib/orbit-bridge';

/** Fired on `window` when the game says something changed, for pages that keep their own data. */
export const ORBIT_REFRESH_EVENT = 'orbit:refresh';
export type OrbitRefreshEventDetail = { topic: OrbitEventTopic };

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
export default function OrbitBridge({ onRefresh }: { onRefresh: () => void }) {
  const router = useRouter();
  const roomRevision = useRef<string | null>(null);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

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
    post({ type: 'orbit-bridge-ready', version: ORBIT_BRIDGE_VERSION, capabilities: ORBIT_BRIDGE_CAPABILITIES });
    return () => window.removeEventListener('message', onMessage);
  }, [router]);

  return null;
}
