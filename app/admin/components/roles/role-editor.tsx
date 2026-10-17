'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { toWire } from '@/lib/permissions';
import { changedCount, permissionsOf, roleLockReason, viewerFrom } from '@/lib/role-ui';
import { EmptyCard, InContext, LoadError, LoadingRows, PageHeader } from '../ds';
import { DisplayTab, type DisplayDraft } from './display-tab';
import { MembersTab } from './members-tab';
import { Panel } from './role-bits';
import { PermissionsTab } from './permissions-tab';
import { UsedInTab } from './used-in-tab';
import { useRolesData } from './use-roles-data';

/**
 * One role: swipeable tabs Display, Permissions, Members and Used in, opening on Permissions. Everyone has only
 * Permissions and Used in. Changes are held here and saved together; the Save bar shows only after a change.
 */
export function RoleEditPage() {
  const params = useParams();
  const universeId = params.id as string;
  const roleId = params.roleId as string;
  const router = useRouter();
  const replacePage = useReplacePage();
  const { addToast } = useToast();
  const { state, reload } = useRolesData(universeId);
  const [tab, setTab] = useState('permissions');
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const data = state.status === 'ready' ? state.data : null;
  const role = data?.roles.roles.find((item) => item.id === roleId) ?? null;

  // What is held while editing: starts as what the server has, and starts over whenever the server's copy changes
  const roleName = role?.name;
  const roleColour = role?.color;
  const roleBadge = role?.badge ?? '';
  const rolePermissions = role?.permissions;
  // Keyed by value, so a reload that changes nothing here (a new people count) keeps what is being typed
  const saved = useMemo<{ display: DisplayDraft; permissions: bigint } | null>(
    () =>
      roleName !== undefined && roleColour !== undefined && rolePermissions !== undefined
        ? { display: { name: roleName, color: roleColour, badge: roleBadge }, permissions: permissionsOf({ permissions: rolePermissions }) }
        : null,
    [roleName, roleColour, roleBadge, rolePermissions],
  );
  const [display, setDisplay] = useState<DisplayDraft | null>(null);
  const [permissions, setPermissions] = useState<bigint | null>(null);
  useEffect(() => {
    if (saved) {
      setDisplay(saved.display);
      setPermissions(saved.permissions);
    }
  }, [saved]);

  if (state.status === 'loading') {
    return (
      <div className="grid gap-6">
        <PageHeader kind="role" title="Role" />
        <LoadingRows label="the role" rows={3} />
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="grid gap-6">
        <PageHeader kind="role" title="Role" />
        <LoadError label="the role" retry={() => void reload()} />
      </div>
    );
  }
  if (state.status === 'missing' || !data || !role) {
    return (
      <div className="grid gap-6">
        <PageHeader kind="role" title="Role" />
        <EmptyCard
          kind="role"
          title="This role doesn’t exist."
          text="It may have been deleted."
          href={`/admin/universes/${universeId}/roles`}
          action="Roles & permissions"
        />
      </div>
    );
  }
  if (display === null || permissions === null || saved === null) return <LoadingRows label="the role" rows={3} />;

  const { universe, roles, me } = data;
  const draft = display;
  const draftPermissions = permissions;
  const viewer = viewerFrom(me);
  const lockedReason = roleLockReason(role, viewer);
  const isEveryone = role.builtIn && role.key === 'everyone';
  const isAdmin = role.builtIn && role.key === 'admin';

  const nameChanged = display.name.trim() !== saved.display.name;
  const colourChanged = display.color.toLowerCase() !== saved.display.color.toLowerCase();
  const badgeChanged = display.badge.trim() !== saved.display.badge;
  const permissionsChanged = changedCount(permissions, saved.permissions);
  const changes = (nameChanged ? 1 : 0) + (colourChanged ? 1 : 0) + (badgeChanged ? 1 : 0) + permissionsChanged;
  const blankName = display.name.trim().length === 0;

  async function save() {
    if (!role || changes === 0 || blankName || saving) return;
    setSaving(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${universeId}/roles/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(nameChanged ? { name: draft.name.trim() } : {}),
          ...(colourChanged ? { color: draft.color } : {}),
          ...(badgeChanged ? { badge: draft.badge.trim() || null } : {}),
          ...(permissionsChanged > 0 ? { permissions: toWire(draftPermissions) } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'That didn’t work. Try again.');
      addToast({ description: 'Saved', variant: 'success' });
      await reload();
    } catch (failure) {
      addToast({ description: failure instanceof Error ? failure.message : 'That didn’t work. Try again.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function duplicate() {
    if (!role || duplicating) return;
    setDuplicating(true);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${universeId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: `${role.name} copy`.slice(0, 40),
          color: role.color,
          ...(role.badge ? { badge: role.badge } : {}),
          permissions: role.permissions,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'That didn’t work. Try again.');
      router.push(`/admin/universes/${universeId}/roles/${result.role.id}`);
    } catch (failure) {
      addToast({ description: failure instanceof Error ? failure.message : 'That didn’t work. Try again.', variant: 'error' });
    } finally {
      setDuplicating(false);
    }
  }

  async function remove(): Promise<boolean> {
    if (!role) return false;
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${universeId}/roles/${role.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'That didn’t work. Try again.');
      }
      addToast({ description: `${role.name} is deleted`, variant: 'success' });
      replacePage(`/admin/universes/${universeId}/roles`);
      return true;
    } catch (failure) {
      addToast({ description: failure instanceof Error ? failure.message : 'That didn’t work. Try again.', variant: 'error' });
      return false;
    }
  }

  // Everyone is everybody: nobody holds it, so it has no display or members to edit
  const tabs = isEveryone
    ? [
        { value: 'permissions', label: 'Permissions' },
        { value: 'used-in', label: 'Used in' },
      ]
    : [
        { value: 'display', label: 'Display' },
        { value: 'permissions', label: 'Permissions' },
        { value: 'members', label: 'Members' },
        { value: 'used-in', label: 'Used in' },
      ];
  const showDuplicate = roles.canManageRoles && !isAdmin && !isEveryone;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <PageHeader
        kind="role"
        title={display.name.trim() || role.name}
        context={
          <InContext
            parts={[
              { label: universe.name, href: `/admin/universes/${universeId}` },
              { label: 'Roles & permissions', href: `/admin/universes/${universeId}/roles` },
            ]}
          />
        }
        status={role.builtIn ? <span className="text-sm text-muted-foreground"> · Built in</span> : undefined}
        actions={
          showDuplicate ? (
            <Button type="button" variant="outline" className="h-12 px-5 text-[15px]" disabled={duplicating} onClick={() => void duplicate()}>
              {duplicating ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Copy aria-hidden="true" />}
              Duplicate
            </Button>
          ) : undefined
        }
      />

      {isEveryone && (
        <Panel className="max-w-3xl">
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Every visitor, signed in or guest. Nobody gives or takes it, and it has no badge. What you switch on here, everybody gets, before any role.
          </p>
        </Panel>
      )}

      <Tabs value={tab} onValueChange={setTab} className="grid min-w-0 max-w-3xl grid-cols-1 gap-4">
        <TabsList aria-label="Role">
          {tabs.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="px-2">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {!isEveryone && (
          <TabsContent value="display" className="mt-0">
            <DisplayTab role={role} draft={display} onChange={setDisplay} lockedReason={lockedReason} onDelete={remove} />
          </TabsContent>
        )}
        <TabsContent value="permissions" className="mt-0">
          <PermissionsTab role={role} viewer={viewer} universeName={universe.name} draft={permissions} onChange={setPermissions} />
        </TabsContent>
        {!isEveryone && (
          <TabsContent value="members" className="mt-0">
            <MembersTab role={role} universeId={universeId} worlds={universe.worlds} me={me} onChanged={() => void reload()} />
          </TabsContent>
        )}
        <TabsContent value="used-in" className="mt-0">
          <UsedInTab role={role} universeId={universeId} universeName={universe.name} />
        </TabsContent>
      </Tabs>

      {changes > 0 && !lockedReason && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="sticky bottom-3 z-30 flex max-w-3xl items-center gap-2 rounded-2xl border border-foreground/10 bg-background/90 px-4 py-3 shadow-[0_12px_40px_-12px_rgba(0,0,0,.6)] backdrop-blur"
        >
          <span className="min-w-0 flex-1 text-sm font-semibold">
            {changes} unsaved {changes === 1 ? 'change' : 'changes'}
          </span>
          <Button
            type="button"
            variant="outline"
            className="h-11 px-4"
            disabled={saving}
            onClick={() => {
              setDisplay(saved.display);
              setPermissions(saved.permissions);
            }}
          >
            Undo
          </Button>
          <Button type="button" className="h-11 px-4" disabled={saving || blankName} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}
