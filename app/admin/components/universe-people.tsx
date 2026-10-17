'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '@/lib/client-auth';
import { RolePill } from '@/components/ui/choice';
import type { RoleInfo, RoleSummary } from '@/lib/member-roles';

/** What the people screens of a universe need to know about it: its name, owner and worlds. */
export interface UniverseBasics {
  id: string;
  name: string;
  ownerId: string;
  worlds: { id: string; name: string }[];
}

export type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/** One GET, with a way to ask again. A failure says so (it never leaves the page loading). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each caller reads its own answer shape
export function useJson<T>(path: string | null, read: (body: any) => T): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState({ status: 'loading' });
    authenticatedFetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const value = read(await response.json());
        if (!cancelled) setState({ status: 'ready', value });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `read` only shapes the answer; the path is what decides when to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return [state, retry];
}

export function useUniverseBasics(universeId: string | null): Loaded<UniverseBasics> {
  const [state] = useJson<UniverseBasics>(universeId ? `/api/admin/universes/${encodeURIComponent(universeId)}` : null, (body) => ({
    id: body.id ?? universeId,
    name: body.name ?? 'this universe',
    ownerId: body.ownerId ?? '',
    worlds: Array.isArray(body.worlds) ? body.worlds.map((world: { id: string; name: string }) => ({ id: world.id, name: world.name })) : [],
  }));
  return state;
}

export interface UniverseRole extends RoleInfo {
  position: number;
  people: number | null;
}

/** The universe's roles, highest first, by id. */
export function useUniverseRoles(universeId: string | null): Loaded<{ list: UniverseRole[]; byId: Map<string, UniverseRole> }> {
  const [state] = useJson(universeId ? `/api/admin/universes/${encodeURIComponent(universeId)}/roles` : null, (body) => {
    const list: UniverseRole[] = Array.isArray(body.roles) ? body.roles : [];
    return { list, byId: new Map(list.map((role) => [role.id, role])) };
  });
  return state;
}

export function useWorldNames(basics: Loaded<UniverseBasics>): Map<string, string> {
  return useMemo(
    () => new Map(basics.status === 'ready' ? basics.value.worlds.map((world) => [world.id, world.name] as const) : []),
    [basics],
  );
}

/** A role as a neutral pill with its colour dot. */
export function RoleChip({ name, color }: { name: string; color: string }) {
  return <RolePill name={name} color={color} />;
}

/** The highest role, where it works, and "+N" for the rest: what a row or a face shows of someone's roles. */
export function RoleSummaryPills({ summary, showWhere = true }: { summary: RoleSummary; showWhere?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <RoleChip name={summary.name} color={summary.color} />
      {showWhere && summary.where && <span className="text-xs text-muted-foreground">{summary.where}</span>}
      {summary.more > 0 && <RolePill name={`+${summary.more}`} />}
    </span>
  );
}
