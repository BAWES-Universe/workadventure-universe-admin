'use client';

import { useId, useState } from 'react';
import { AlertTriangle, Lock, Search } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { PERMISSIONS, PERMISSION_GROUPS, flag, withUniverse, type PermissionInfo, type PermissionKey } from '@/lib/permissions';
import {
  PERMISSION_TOTAL,
  countOn,
  permissionLockReason,
  roleLockReason,
  type RoleRow,
  type Viewer,
} from '@/lib/role-ui';

const ZERO = BigInt(0);

/** Roles that cannot be given Administrator: it would make everyone, or everyone who joined, an owner. */
function offersAdministrator(role: Pick<RoleRow, 'key' | 'builtIn'>): boolean {
  return !(role.builtIn && (role.key === 'admin' || role.key === 'everyone' || role.key === 'member'));
}

/** Every permission with a switch, in groups. A switch the viewer cannot move is dimmed with a lock, and says why. */
export function PermissionsTab({
  role,
  viewer,
  universeName,
  draft,
  onChange,
}: {
  role: RoleRow;
  viewer: Viewer;
  universeName: string;
  draft: bigint;
  onChange: (next: bigint) => void;
}) {
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState(false);
  const searchId = useId();
  const isAdmin = role.builtIn && role.key === 'admin';
  const isEveryone = role.builtIn && role.key === 'everyone';
  const wholeReason = isAdmin ? null : roleLockReason(role, viewer);

  const needle = query.trim().toLowerCase();
  const matches = (info: PermissionInfo) =>
    !needle || `${withUniverse(info.label, universeName)} ${withUniverse(info.description, universeName)}`.toLowerCase().includes(needle);

  function set(key: PermissionKey, on: boolean) {
    const bit = flag(key);
    onChange(on ? draft | bit : draft & ~bit);
  }

  const on = countOn(draft);
  const intro = isAdmin
    ? `${on} of ${PERMISSION_TOTAL} on. Admin always has every permission, so these can’t be switched off. To give fewer, make your own role.`
    : isEveryone
      ? `${on} of ${PERMISSION_TOTAL} on. Usually all off: rooms and map areas can still open to everyone on their own.`
      : `${on} of ${PERMISSION_TOTAL} on. Everything Everyone can do is included. Which rooms and areas this role opens is set on each room and area: see Used in.`;

  return (
    <div className="grid gap-5">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search permissions
        </label>
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search permissions"
          autoComplete="off"
          className="h-12 rounded-2xl pl-11 text-base"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="-mt-2 max-w-2xl text-sm text-muted-foreground">
        {intro}
        {wholeReason && <> {wholeReason} to change these.</>}
      </p>

      {PERMISSION_GROUPS.map((group) => {
        const items = PERMISSIONS.filter(
          (info) => info.group === group.group && matches(info) && (info.key !== 'ADMINISTRATOR' || offersAdministrator(role)),
        );
        if (items.length === 0) return null;
        return (
          <section key={group.group} aria-label={group.label} className="grid gap-2.5">
            <h3 className="orbit-display text-base font-bold">{group.label}</h3>
            {items.map((info) => {
              const label = withUniverse(info.label, universeName);
              const reason = permissionLockReason(role, viewer, draft, info.key, universeName);
              // The reason for the whole role is said once above; a row says its own
              const rowReason = reason && reason !== wholeReason && !isAdmin ? reason : null;
              const locked = reason !== null;
              const checked = (draft & flag(info.key)) !== ZERO || (info.key !== 'ADMINISTRATOR' && (draft & flag('ADMINISTRATOR')) !== ZERO);
              const owner = info.key === 'ADMINISTRATOR';
              const id = `perm-${info.key}`;
              return (
                <label
                  key={info.key}
                  htmlFor={id}
                  data-testid={`permission-${info.key}`}
                  className={cn(
                    'flex items-center gap-3 rounded-2xl border px-3.5 py-3',
                    owner ? 'border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.07)]' : 'border-foreground/[.08] bg-foreground/[.04]',
                    locked ? 'cursor-not-allowed' : 'cursor-pointer',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <strong id={`${id}-label`} className={cn('flex items-center gap-1.5 text-sm font-semibold', owner && 'text-[#fca5a5]')}>
                      {owner && <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
                      {label}
                    </strong>
                    <span id={`${id}-hint`} className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {withUniverse(info.description, universeName)}
                      {owner && !locked && ' Asks you to confirm.'}
                    </span>
                    {rowReason && (
                      <span className="mt-1 block text-xs font-medium text-muted-foreground">
                        {rowReason}
                      </span>
                    )}
                  </span>
                  {locked && <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <Switch
                    id={id}
                    checked={checked}
                    locked={locked}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={`${id}-hint`}
                    onCheckedChange={(next) => (owner && next ? setConfirming(true) : set(info.key, next))}
                  />
                </label>
              );
            })}
          </section>
        );
      })}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make {role.name} like the owner of {universeName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Administrator gives every permission in every world and gets past every room and area rule. It can’t be limited to some worlds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                set('ADMINISTRATOR', true);
                setConfirming(false);
              }}
            >
              Switch on Administrator
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
