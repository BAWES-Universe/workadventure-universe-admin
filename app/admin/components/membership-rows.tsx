'use client';

import { Button } from '@/components/ui/button';
import { worldsLabel } from '@/lib/member-roles';
import { EntityRow, Place, StatLine } from './ds';
import { RoleChip } from './universe-people';

/** A universe you belong to, as /api/memberships/my/universes gives it. */
export interface UniverseMembership {
  /** createdAt: when the universe was made (Created on an owned row). */
  universe: { id: string; name: string; createdAt?: string; worlds: { id: string; name: string }[] };
  isOwner: boolean;
  joinedAt: string;
  worlds: { allWorlds: boolean; worldIds: string[] };
  roles: { key: string; name: string; color: string; allWorlds: boolean; worldIds: string[] }[];
}

const month = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

/** The worlds you're in there: one or two names, else a count; null when it has none. */
function worldsIn(membership: UniverseMembership): string | null {
  const inWorlds = membership.worlds.allWorlds
    ? membership.universe.worlds
    : membership.universe.worlds.filter((world) => membership.worlds.worldIds.includes(world.id));
  if (inWorlds.length === 0) return null;
  return inWorlds.length <= 2 ? inWorlds.map((world) => world.name).join(' and ') : `${inWorlds.length} worlds`;
}

type Scope = { allWorlds: boolean; worldIds: string[] };

/** The same worlds, whatever order they were picked in. */
function sameWorlds(a: Scope, b: Scope): boolean {
  if (a.allWorlds || b.allWorlds) return a.allWorlds === b.allWorlds;
  const ids = new Set(a.worldIds);
  return ids.size === new Set(b.worldIds).size && b.worldIds.every((id) => ids.has(id));
}

/** Your roles there; a role says where it works only when that differs from the worlds you're in. */
function Roles({ membership }: { membership: UniverseMembership }) {
  const names = new Map(membership.universe.worlds.map((world) => [world.id, world.name]));
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {membership.roles.length === 0 && <RoleChip name="Member" color="#A78BFA" />}
      {membership.roles.map((role) => {
        const where = worldsLabel(role, names);
        return (
          <span key={role.key} className="inline-flex items-center gap-1.5">
            <RoleChip name={role.name} color={role.color} />
            {where && !sameWorlds(role, membership.worlds) && <span className="text-xs text-muted-foreground">{where}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** A universe you own: its section says so, so the row is the name, its worlds (all yours) and when you made it. */
export function OwnedUniverseRow({ membership }: { membership: UniverseMembership }) {
  // The owner has every world, whatever an older membership row says.
  const where = worldsIn({ ...membership, worlds: { allWorlds: true, worldIds: [] } });
  return (
    <EntityRow
      href={`/admin/universes/${membership.universe.id}`}
      kind="universe"
      universeId={membership.universe.id}
      title={membership.universe.name}
      context={<StatLine items={[where ? <Place key="worlds" kind="world" label={where} /> : 'No worlds yet', `Created ${month(membership.universe.createdAt ?? membership.joinedAt)}`]} />}
    />
  );
}

/** A universe someone else owns: your roles by the name, your worlds and when you joined, and a quiet Leave. */
export function JoinedUniverseRow({ membership, onLeave }: { membership: UniverseMembership; onLeave?: () => void }) {
  const where = worldsIn(membership);
  return (
    <EntityRow
      href={`/admin/universes/${membership.universe.id}`}
      kind="universe"
      universeId={membership.universe.id}
      title={membership.universe.name}
      titleAside={<Roles membership={membership} />}
      context={<StatLine items={[where && <Place key="worlds" kind="world" label={where} />, `Joined ${month(membership.joinedAt)}`]} />}
      trailing={
        onLeave ? (
          <Button variant="ghost" className="h-11 px-3 text-muted-foreground" onClick={onLeave} aria-label={`Leave ${membership.universe.name}`}>
            Leave
          </Button>
        ) : undefined
      }
    />
  );
}
