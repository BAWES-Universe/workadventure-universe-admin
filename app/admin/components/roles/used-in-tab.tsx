'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { DoorOpen } from 'lucide-react';
import { PERMISSIONS, withUniverse } from '@/lib/permissions';
import type { UsedIn, UsedInRoom } from '@/lib/role-used-in';
import type { RoleRow } from '@/lib/role-ui';
import { RolePill } from '@/components/ui/choice';
import { LoadError, LoadingRows } from '../ds';
import { Panel } from './role-bits';

/** "Lobby, Finance and 3 more". */
function names(rooms: UsedInRoom[], total: number): string {
  const listed = rooms.map((room) => room.name).join(', ');
  return total > rooms.length ? `${listed} and ${total - rooms.length} more` : listed;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  );
}

/** What was not checked, said apart: maps past the cap were never tried, the others were tried and could not be read. */
function mapAreaNotes(areas: UsedIn['reach']['mapAreas']): string[] {
  if (areas.status === 'not_configured') return ['Orbit cannot read map areas here: this server has no map-storage address, so none can be listed.'];
  const notes: string[] = [];
  if (areas.skipped > 0) notes.push(`Read the first ${(areas.read + areas.unread).toLocaleString()} maps; ${areas.skipped.toLocaleString()} more not checked.`);
  if (areas.unread > 0) notes.push(`${areas.unread === 1 ? '1 map' : `${areas.unread.toLocaleString()} maps`} could not be read.`);
  return notes;
}

/** Where the role opens doors, and what it reaches. Only what Orbit can read is listed; what it cannot read is said. */
export function UsedInTab({ role, universeId, universeName }: { role: RoleRow; universeId: string; universeName: string }) {
  const [data, setData] = useState<UsedIn | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${universeId}/roles/${role.id}/used-in`);
      if (!response.ok) throw new Error('Could not load');
      setData(await response.json());
    } catch {
      setFailed(true);
    }
  }, [universeId, role.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <LoadError label="where this role is used" retry={() => void load()} />;
  if (!data) return <LoadingRows label="where this role is used" rows={3} />;

  const { doors, reach } = data;
  const areas = reach.mapAreas;
  const permissionLabels = reach.permissions.includes('ADMINISTRATOR')
    ? ['Every permission']
    : PERMISSIONS.filter((info) => reach.permissions.includes(info.key)).map((info) => withUniverse(info.label, universeName));

  return (
    <div className="grid gap-4">
      <Panel className="grid gap-3 p-5">
        <h2 className="orbit-display text-lg font-bold">Where it opens doors</h2>
        {doors.rooms.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No room is set to {role.name} yet. Rooms open to a role come in a later release. Map areas locked to it are listed below.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {doors.basis === 'members' ? 'Rooms that only the people of their world can enter.' : 'Rooms open to everyone.'}
            </p>
            <ul className="grid gap-1" aria-label="Rooms">
              {doors.rooms.map((room) => (
                <li key={room.id}>
                  <Link href={`/admin/rooms/${room.id}`} className="flex min-h-12 items-center gap-3 rounded-2xl px-1 hover:bg-foreground/5">
                    <DoorOpen className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-base">{room.name}</span>
                    <RolePill name={room.worldName} />
                  </Link>
                </li>
              ))}
            </ul>
            {doors.roomsTotal > doors.rooms.length && (
              <p className="text-sm text-muted-foreground">and {doors.roomsTotal - doors.rooms.length} more</p>
            )}
            <p className="text-sm text-muted-foreground">Set on the room. Change it there.</p>
          </>
        )}
      </Panel>

      <Panel className="grid gap-4 p-5">
        <div className="grid gap-1.5">
          <h2 className="orbit-display text-lg font-bold">What {role.name} can reach</h2>
          <p className="text-sm text-muted-foreground">Worked out from who has it and where.</p>
        </div>
        <dl className="grid gap-4">
          <Line label="Worlds">
            {reach.worlds.length === 0
              ? reach.held
                ? 'Not in any world you can see'
                : 'None yet: no one has it'
              : reach.allWorlds
                ? `Every world: ${reach.worlds.map((world) => world.name).join(', ')}`
                : reach.worlds.map((world) => world.name).join(', ')}
          </Line>
          <Line label="Rooms">{reach.rooms.length === 0 ? (reach.held ? 'None you can see' : 'None yet') : names(reach.rooms, reach.roomsTotal)}</Line>
          <Line label="Map areas">
            {areas.areas.length > 0 ? (
              <ul className="grid gap-1" aria-label="Map areas locked to this role">
                {areas.areas.map((area, index) => (
                  <li key={`${area.roomId}-${area.areaName}-${area.level}-${index}`}>
                    {area.areaName} <span className="text-muted-foreground">in {area.roomName}, {area.worldName} · {area.level === 'enter' ? 'can enter' : 'can edit'}</span>
                  </li>
                ))}
              </ul>
            ) : areas.status === 'not_configured' ? (
              'Not known'
            ) : (
              'None locked to this role'
            )}
            {mapAreaNotes(areas).map((note) => (
              <span key={note} className="mt-1 block text-sm text-muted-foreground" data-testid="map-areas-note">
                {note}
              </span>
            ))}
          </Line>
          <Line label="Permissions">{permissionLabels.length === 0 ? 'None' : permissionLabels.join(', ')}</Line>
        </dl>
      </Panel>
    </div>
  );
}
