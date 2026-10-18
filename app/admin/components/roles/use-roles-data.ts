'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MeResponse, RolesResponse, WorldRef } from '@/lib/role-ui';

export interface RolesData {
  universe: { id: string; name: string; worlds: WorldRef[] };
  roles: RolesResponse;
  me: MeResponse;
}

export type RolesState =
  | { status: 'loading' }
  | { status: 'failed' }
  /** Gone, private or not yours: the page says so in place. */
  | { status: 'missing' }
  | { status: 'ready'; data: RolesData };

/** What both Roles & permissions pages start from: the universe, its roles, and what you may do in it. */
export function useRolesData(universeId: string): { state: RolesState; reload: () => Promise<void>; setRoles: (roles: RolesResponse) => void } {
  const [state, setState] = useState<RolesState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const [universe, roles, me] = await Promise.all([
        authenticatedFetch(`/api/admin/universes/${universeId}`),
        authenticatedFetch(`/api/admin/universes/${universeId}/roles`),
        authenticatedFetch(`/api/admin/universes/${universeId}/me`),
      ]);
      if (universe.status === 404 || roles.status === 404 || me.status === 404) {
        setState({ status: 'missing' });
        return;
      }
      if (!universe.ok || !roles.ok || !me.ok) throw new Error('Could not load roles');
      const universeData = await universe.json();
      setState({
        status: 'ready',
        data: {
          universe: {
            id: universeData.id,
            name: universeData.name,
            worlds: ((universeData.worlds ?? []) as WorldRef[]).map((world) => ({ id: world.id, name: world.name })),
          },
          roles: await roles.json(),
          me: await me.json(),
        },
      });
    } catch {
      // A reload that fails keeps what is shown
      setState((current) => (current.status === 'ready' ? current : { status: 'failed' }));
    }
  }, [universeId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Show a new order straight away, before the next reload. */
  const setRoles = useCallback((roles: RolesResponse) => {
    setState((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, roles } } : current));
  }, []);

  return { state, reload: load, setRoles };
}
