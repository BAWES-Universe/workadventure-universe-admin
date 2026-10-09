'use client';

import { useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import type { LivePlace } from '@/lib/live-presence';
import { useLive } from './use-live';

/** Someone shown by their face: a name and the Woka layers. */
export interface Face {
  name: string;
  woka: string[];
}

/** Who is in a place right now, as you may see it. */
export interface Here {
  /** Everyone counted: the people listed, guests and bots. */
  count: number;
  people: Face[];
  youAreHere: boolean;
}

const NOBODY: Here = { count: 0, people: [], youAreHere: false };

function hereOf(places: LivePlace[]): Here {
  if (places.length === 0) return NOBODY;
  const seen = new Set<string>();
  const people: Face[] = [];
  for (const place of places) {
    for (const person of place.people) {
      if (seen.has(person.uuid)) continue;
      seen.add(person.uuid);
      people.push({ name: person.name, woka: person.woka });
    }
  }
  return {
    count: places.reduce((sum, place) => sum + place.count, 0),
    people,
    youAreHere: places.some((place) => place.here),
  };
}

/**
 * Who is in a universe, world or room right now, and in each room of it. `known` is false while the game can't say,
 * so the page shows a dash instead of claiming the place is empty.
 */
export function useHere(scope: 'universe' | 'world' | 'room', id: string) {
  const live = useLive();
  return useMemo(() => {
    if (!live) return { known: false, here: NOBODY, byRoom: new Map<string, Here>() };
    const inScope = live.places.filter((place) =>
      scope === 'universe' ? place.universe.id === id : scope === 'world' ? place.world.id === id : place.roomId === id,
    );
    return {
      known: true,
      here: hereOf(inScope),
      byRoom: new Map(live.places.map((place) => [place.roomId, hereOf([place])] as const)),
    };
  }, [live, scope, id]);
}

export interface MemberPreview {
  id: string;
  tags: string[];
  isUniverseOwner: boolean;
  woka?: string[];
  user: { id: string; name: string | null; email: string | null };
}

export interface MembersPreview {
  members: MemberPreview[];
  total: number;
  canManage: boolean;
  /** The viewer's own roles in the world. */
  yourTags: string[];
  /** The viewer's user id, so their own face can be told apart. */
  yourId: string | null;
  /** The universe the world belongs to, for "You own …" and "Owns …" on a member card. */
  universeName: string | null;
}

/** A world's first members by rank, how many there are in all, and your own roles; the full list is its own page. */
export function useMembersPreview(worldId: string, limit = 8): MembersPreview | null {
  const [data, setData] = useState<MembersPreview | null>(null);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(`/api/admin/worlds/${worldId}/members?limit=${limit}`)
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const body = await response.json();
        const members: MemberPreview[] = body.members ?? [];
        if (!cancelled) {
          setData({
            members,
            total: typeof body.total === 'number' ? body.total : members.length,
            canManage: !!body.canManage,
            yourTags: Array.isArray(body.yourTags) ? body.yourTags : [],
            yourId: typeof body.yourId === 'string' ? body.yourId : null,
            universeName: typeof body.universeName === 'string' ? body.universeName : null,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [worldId, limit]);
  return data;
}

export interface WorldWithRooms {
  id: string;
  slug: string;
  name: string;
  rooms: { id: string; slug: string; name: string; description: string | null; _count: { favorites: number } }[];
}

/** Worlds past this many show their heading only: each one needs its own request for its rooms. */
export const MAX_WORLDS_WITH_ROOMS = 12;

/** The rooms of a universe's worlds (a universe's own answer lists no rooms). Each world is asked for once. */
export function useWorldRooms(worldIds: readonly string[]): Record<string, WorldWithRooms> {
  const key = worldIds.slice(0, MAX_WORLDS_WITH_ROOMS).join('\n');
  const [worlds, setWorlds] = useState<Record<string, WorldWithRooms>>({});
  useEffect(() => {
    let cancelled = false;
    for (const id of key ? key.split('\n') : []) {
      authenticatedFetch(`/api/admin/worlds/${id}`)
        .then(async (response) => {
          if (!response.ok || cancelled) return;
          const world = (await response.json()) as WorldWithRooms;
          if (!cancelled) setWorlds((previous) => ({ ...previous, [id]: world }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [key]);
  return worlds;
}

/** Where a public universe stands this week by visits, or null (private, no visits, or the server can't say). */
export function useUniverseRank(universeId: string, enabled: boolean): { position: number; of: number } | null {
  const [rank, setRank] = useState<{ position: number; of: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authenticatedFetch(`/api/admin/universes/${universeId}/rank`)
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const body = await response.json();
        if (!cancelled) setRank(body.rank && Number.isFinite(body.rank.position) && Number.isFinite(body.rank.of) ? body.rank : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [universeId, enabled]);
  return rank;
}

export interface StarState {
  isStarred: boolean;
  starCount: number;
}

/** Stars or unstars a universe or world right away, putting it back if the server says no. */
export function useStarToggle(path: string, state: StarState | null, apply: (next: StarState) => void) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!state || busy) return;
    const before = state;
    apply({ isStarred: !before.isStarred, starCount: Math.max(0, before.starCount + (before.isStarred ? -1 : 1)) });
    setBusy(true);
    try {
      const response = await authenticatedFetch(path, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to toggle star');
      const data = await response.json();
      apply({ isStarred: !!data.isStarred, starCount: typeof data.starCount === 'number' ? data.starCount : before.starCount });
    } catch (error) {
      apply(before);
      alert(error instanceof Error ? error.message : 'Failed to toggle star');
    } finally {
      setBusy(false);
    }
  };
  return { toggle, busy };
}
