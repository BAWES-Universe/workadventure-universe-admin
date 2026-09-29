'use client';

import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import type { QuestContext, QuestContextArea, QuestContextBot } from '@/lib/quests/model';

export interface QuestRoom {
  id: string;
  name: string;
  slug: string;
  canEdit: boolean;
  world: { id: string; name: string; slug: string; universe: { id: string; name: string; slug: string } };
}

export type QuestRoomState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'missing' }
  | { status: 'ready'; room: QuestRoom; context: QuestContext | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNamedPlace<T extends Record<string, unknown>>(value: T): value is T & { id: string; name: string; slug: string } {
  return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.slug === 'string';
}

function parseRoom(value: unknown): QuestRoom | null {
  if (!isRecord(value) || !isNamedPlace(value) || !isRecord(value.world)) return null;
  const world = value.world;
  if (!isNamedPlace(world) || !isRecord(world.universe) || !isNamedPlace(world.universe)) return null;
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    // As on the room's page: only an explicit false takes editing away; the server checks again either way.
    canEdit: value.canEdit !== false,
    world: {
      id: world.id,
      name: world.name,
      slug: world.slug,
      universe: { id: world.universe.id, name: world.universe.name, slug: world.universe.slug },
    },
  };
}

const named = (value: unknown): value is QuestContextArea | QuestContextBot =>
  isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';

function parseContext(value: unknown): QuestContext | null {
  if (!isRecord(value) || !Array.isArray(value.areas) || !Array.isArray(value.bots)) return null;
  return {
    areas: value.areas.filter(named).map(({ id, name }) => ({ id, name })),
    bots: value.bots.filter(named).map(({ id, name }) => ({ id, name })),
    source: value.source === 'wam' ? 'wam' : 'none',
  };
}

/**
 * The room a quest page is about and, when asked for, what a quest can point at there (its areas and bots, only for
 * those who can edit the room).
 */
export function useQuestRoom(roomId: string, withContext: boolean): { state: QuestRoomState; retry: () => void } {
  const [state, setState] = useState<QuestRoomState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        const response = await authenticatedFetch(`/api/admin/rooms/${encodeURIComponent(roomId)}`, { signal: controller.signal });
        if (response.status === 404) {
          if (!controller.signal.aborted) setState({ status: 'missing' });
          return;
        }
        if (!response.ok) throw new Error('Room unavailable');
        const room = parseRoom(await response.json());
        if (!room) throw new Error('Invalid room');
        let context: QuestContext | null = null;
        if (withContext && room.canEdit) {
          const contextResponse = await authenticatedFetch(`/api/admin/rooms/${encodeURIComponent(roomId)}/quest-context`, {
            signal: controller.signal,
          });
          if (contextResponse.status === 403) room.canEdit = false;
          else if (!contextResponse.ok) throw new Error('Quest context unavailable');
          else context = parseContext(await contextResponse.json());
          if (room.canEdit && !context) throw new Error('Invalid quest context');
        }
        if (!controller.signal.aborted) setState({ status: 'ready', room, context });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [roomId, withContext, attempt]);

  return { state, retry };
}
