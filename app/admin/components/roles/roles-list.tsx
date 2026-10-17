'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronRight, GripVertical, Lock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { EmptyCard, InContext, LoadError, LoadingRows, PageHeader } from '../ds';
import { CreateRoleSheet } from './create-role-sheet';
import { Group, RoleDot } from './role-bits';
import { useRolesData } from './use-roles-data';
import { builtInRoles, customRoles, movableRoles, roleLine, viewerFrom, type RoleRow } from '@/lib/role-ui';

function place(ids: string[], id: string, to: number) {
  const rest = ids.filter((other) => other !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
}

/** Roles & permissions: custom roles first, highest first, dragged to change rank; the built-in ones sit apart. */
export function RolesListPage() {
  const params = useParams();
  const universeId = params.id as string;
  const router = useRouter();
  const { addToast } = useToast();
  const { state, reload } = useRolesData(universeId);
  const [creating, setCreating] = useState(false);

  // The order of the roles you can move, highest first, while one is dragged or just moved
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const startOrder = useRef<string[]>([]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<string[] | null>(null);
  // The order as of the last move, whatever the screen has drawn yet, so a move always builds on the one before it
  const orderRef = useRef<string[] | null>(null);
  // Counts the moves, so a save that was started before a later move cannot throw that move away
  const revision = useRef(0);
  // Saves go one after another, so an older order never lands after a newer one
  const queue = useRef<Promise<void>>(Promise.resolve());

  const data = state.status === 'ready' ? state.data : null;
  const movable = data ? movableRoles(data.roles.roles, { ...data.me, canManageRoles: data.roles.canManageRoles }) : [];

  // Leaving the page mid-wait must not send a late save
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const changeOrder = useCallback((next: string[]) => {
    orderRef.current = next;
    revision.current += 1;
    setOrder(next);
  }, []);

  const run = useCallback(
    async (ids: string[], movesAtStart: number) => {
      try {
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch(`/api/admin/universes/${universeId}/roles/order`, {
          method: 'PUT',
          body: JSON.stringify({ roleIds: ids }),
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || 'That didn’t work. Try again.');
        }
        addToast({ description: 'Order saved', variant: 'success', duration: 1500 });
      } catch (failure) {
        addToast({ description: failure instanceof Error ? failure.message : 'That didn’t work. Try again.', variant: 'error' });
      }
      await reload();
      // Show what the server has (the old order when the save failed), unless the roles were moved again meanwhile:
      // then the newer order stays on screen and its own save settles it
      if (revision.current === movesAtStart) {
        orderRef.current = null;
        setOrder(null);
      }
    },
    [addToast, reload, universeId],
  );

  const save = useCallback(
    (ids: string[]) => {
      const movesAtStart = revision.current;
      queue.current = queue.current.then(() => run(ids, movesAtStart));
      return queue.current;
    },
    [run],
  );

  // The window listeners of a drag under way, taken off when it ends or the page goes
  const stopFollowing = useRef<(() => void) | null>(null);
  useEffect(() => () => stopFollowing.current?.(), []);

  if (state.status === 'loading') {
    return (
      <div className="grid gap-6">
        <PageHeader kind="role" title="Roles & permissions" />
        <LoadingRows label="roles" rows={4} />
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="grid gap-6">
        <PageHeader kind="role" title="Roles & permissions" />
        <LoadError label="the roles" retry={() => void reload()} />
      </div>
    );
  }
  if (state.status === 'missing' || !data) {
    return (
      <div className="grid gap-6">
        <PageHeader kind="role" title="Roles & permissions" />
        <EmptyCard kind="universe" title="This universe doesn’t exist." text="It may be private, or it was deleted." href="/admin/universes" action="Your universes" />
      </div>
    );
  }

  const { universe, roles, me } = data;
  const viewer = viewerFrom(me);
  const custom = customRoles(roles.roles);
  const byId = new Map(custom.map((role) => [role.id, role]));
  // Custom roles you cannot move stay where they are, above the ones you can
  const fixed = custom.filter((role) => !movable.some((candidate) => candidate.id === role.id));
  const movableOrdered = (order ?? movable.map((role) => role.id)).map((id) => byId.get(id)).filter((role): role is RoleRow => !!role);
  const shown = [...fixed, ...movableOrdered];

  function onHandleDown(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // A move made with the arrow keys and not saved yet is saved now, so its late save can't undo this drag
    if (pending.current) {
      clearTimeout(pending.current);
      pending.current = null;
      if (latest.current) void save(latest.current);
    }
    // The order is pinned only once the row moves: a press without a move leaves the list following the server
    startOrder.current = orderRef.current ?? movable.map((role) => role.id);
    setDragging(id);
    // The window follows the pointer, not the handle: moving rows can take the pointer capture off the handle, and
    // the drop must still land wherever the pointer is let go
    stopFollowing.current?.();
    const onMove = (moved: PointerEvent) => {
      const current = orderRef.current ?? startOrder.current;
      // Its place is the number of other rows whose middle is above the finger
      let index = 0;
      for (const other of current) {
        if (other === id) continue;
        const box = rows.current.get(other)?.getBoundingClientRect();
        if (box && box.top + box.height / 2 < moved.clientY) index += 1;
      }
      const next = place(current, id, index);
      if (next.join(',') !== current.join(',')) changeOrder(next);
    };
    const onUp = () => {
      stopFollowing.current?.();
      setDragging(null);
      const current = orderRef.current;
      if (current && current.join(',') !== startOrder.current.join(',')) void save(current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    stopFollowing.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      stopFollowing.current = null;
    };
  }

  // Arrow keys on the handle move one place; the order is saved once they stop
  function onHandleKey(event: React.KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const current = orderRef.current ?? movable.map((role) => role.id);
    const at = current.indexOf(id);
    const next = place(current, id, event.key === 'ArrowUp' ? at - 1 : at + 1);
    if (next.join(',') === current.join(',')) return;
    changeOrder(next);
    latest.current = next;
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      if (latest.current) void save(latest.current);
    }, 600);
    requestAnimationFrame(() => (document.querySelector(`[data-handle="${id}"]`) as HTMLElement | null)?.focus());
  }

  const href = (role: RoleRow) => `/admin/universes/${universeId}/roles/${role.id}`;

  function row(role: RoleRow, handle: React.ReactNode) {
    return (
      <li
        key={role.id}
        ref={(element) => {
          if (element) rows.current.set(role.id, element);
          else rows.current.delete(role.id);
        }}
        data-testid="role-row"
        data-dragging={dragging === role.id || undefined}
        className={cn(
          'flex min-h-[4.5rem] items-center rounded-2xl border border-foreground/[.08] bg-foreground/[.04] transition-[background-color,border-color,box-shadow] hover:border-foreground/20',
          dragging === role.id &&
            'border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)] shadow-[0_0_0_1px_rgba(167,139,250,.35),0_0_24px_-8px_rgba(134,41,252,.6)]',
        )}
      >
        {handle}
        <Link href={href(role)} className={cn('flex min-w-0 flex-1 items-center gap-3 py-3 pr-4', handle ? 'pl-0' : 'pl-4')}>
          <RoleDot color={role.color} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-base font-bold">
              <span className="truncate">{role.name}</span>
            </span>
            <span className="block truncate text-[13px] text-muted-foreground">{roleLine(role)}</span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      </li>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <PageHeader
        kind="role"
        title="Roles & permissions"
        context={<InContext parts={[{ label: universe.name, href: `/admin/universes/${universeId}` }]} />}
        actions={
          roles.canCreateRoles ? (
            <Button className="h-12 px-6 text-[15px]" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              Create role
            </Button>
          ) : undefined
        }
      />
      <p className="-mt-2 max-w-3xl text-sm text-muted-foreground">
        {roles.canCreateRoles
          ? 'Give roles on the Members page. Rooms and map areas can open to a role.'
          : roles.canManageRoles
            ? 'Needs a role above Editor to create roles. Give roles on the Members page.'
            : 'Needs Manage roles in every world to create or change roles. Give roles on the Members page.'}
      </p>

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2">
        <Group title="Your roles" count={custom.length}>
          {custom.length === 0 ? (
            <EmptyCard
              kind="role"
              title="No roles of your own yet."
              text={roles.canCreateRoles ? 'Create one for a team, a department or a level, then give it to people.' : 'Roles made for this universe show up here.'}
            />
          ) : (
            <>
              <ul className="grid grid-cols-1 gap-3" aria-label="Your roles, highest first">
                {shown.map((role) => {
                  const canMove = movable.some((candidate) => candidate.id === role.id);
                  return row(
                    role,
                    canMove ? (
                      <button
                        type="button"
                        data-handle={role.id}
                        aria-label={`Move ${role.name}. Drag, or use the up and down arrow keys.`}
                        className="orbit-touch-exempt grid h-11 w-11 shrink-0 cursor-grab touch-none place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                        onPointerDown={(event) => onHandleDown(event, role.id)}
                        onKeyDown={(event) => onHandleKey(event, role.id)}
                      >
                        <GripVertical className="h-5 w-5" aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="grid h-11 w-11 shrink-0 place-items-center text-muted-foreground/60" title="Needs a role above this one to move it">
                        <Lock className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">Needs a role above this one to move it</span>
                      </span>
                    ),
                  );
                })}
              </ul>
              <p className="text-sm text-muted-foreground">
                {movable.length > 0 ? 'Highest first. Drag to change who manages whom.' : 'Highest first.'}
              </p>
            </>
          )}
        </Group>

        <Group title="Built in" count={builtInRoles(roles.roles).length}>
          <ul className="grid grid-cols-1 gap-3" aria-label="Built-in roles">
            {builtInRoles(roles.roles).map((role) => row(role, null))}
          </ul>
          <p className="text-sm text-muted-foreground">In every universe. Their names can’t change.</p>
        </Group>
      </div>

      <CreateRoleSheet
        open={creating}
        onOpenChange={setCreating}
        universeId={universeId}
        universeName={universe.name}
        roles={roles.roles}
        viewer={viewer}
        onCreated={(roleId) => {
          setCreating(false);
          router.push(`/admin/universes/${universeId}/roles/${roleId}`);
        }}
      />
    </div>
  );
}
