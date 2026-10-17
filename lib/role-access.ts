/**
 * Who may do what with a universe's roles and people (#314), the Discord way:
 * - The owner of the universe, and super admins, may do everything.
 * - Everyone else ranks by their highest role, and only acts on roles below it: give or take them, edit, rank, delete.
 * - A permission from a role limited to some worlds only works in those worlds. Changing the Roles list itself
 *   (Manage roles) needs the permission in every world: from Everyone, or a role that works in every world.
 * - Nobody hands out a permission they don't have.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, flag, has, parsePermissions, type PermissionKey } from '@/lib/permissions';
import { EVERYONE_KEY, MEMBER_KEY, coversWorld, permissionsInWorld, type ScopedRole, type WorldScope } from '@/lib/roles';

type Db = PrismaClient | Prisma.TransactionClient;

const ZERO = BigInt(0);

export interface Access {
  universeId: string;
  /** The owner, or a super admin: everything, above every role. */
  full: boolean;
  isOwner: boolean;
  /** They joined the universe. */
  inUniverse: boolean;
  /** The rank of their highest role (Everyone 0, Member 1). Infinity when `full`. */
  highest: number;
  /** The universe's worlds, oldest first. */
  worldIds: string[];
  /** Their permissions in every world, today and any made later. */
  everywhere: bigint;
  /** Their permissions in each world of the universe. */
  perWorld: Map<string, bigint>;
}

export interface AccessInput {
  universeId: string;
  worldIds: string[];
  full: boolean;
  isOwner: boolean;
  everyone: bigint;
  member: bigint;
  /** Null when they never joined. */
  membership: WorldScope | null;
  roles: ScopedRole[];
}

/** Work out someone's access from what they hold. Pure, so the rules can be tested without a database. */
export function computeAccess(input: AccessInput): Access {
  const { membership, roles } = input;
  const perWorld = new Map<string, bigint>();
  for (const worldId of input.worldIds) {
    const inWorld = !!membership && (coversWorld(membership, worldId) || roles.some((role) => coversWorld(role, worldId)));
    perWorld.set(
      worldId,
      permissionsInWorld(worldId, input.everyone, membership ? { scope: membership, member: input.member, inWorld } : null, roles),
    );
  }
  let everywhere = input.everyone;
  if (membership?.allWorlds) everywhere |= input.member;
  for (const role of roles) if (role.allWorlds) everywhere |= role.permissions;
  if (has(everywhere, 'ADMINISTRATOR')) everywhere |= ALL_PERMISSIONS;

  const ranks = roles.map((role) => role.position);
  const highest = input.full ? Infinity : Math.max(membership ? 1 : 0, ...ranks);
  return {
    universeId: input.universeId,
    full: input.full,
    isOwner: input.isOwner,
    inUniverse: !!membership,
    highest,
    worldIds: input.worldIds,
    everywhere,
    perWorld,
  };
}

/** Where something applies: every world (today's and later ones), or the worlds listed. */
export type Reach = { allWorlds: true } | { allWorlds: false; worldIds: string[] };

/** Whether they have a permission everywhere a change reaches. */
export function allows(access: Access, key: PermissionKey, reach: Reach): boolean {
  if (access.full) return true;
  if (reach.allWorlds) return has(access.everywhere, key);
  // A deleted world stays listed in old scopes; it no longer exists, so it asks for nothing. Something that reaches
  // only deleted worlds still needs the permission in some world.
  const existing = reach.worldIds.filter((worldId) => access.perWorld.has(worldId));
  if (existing.length === 0 && reach.worldIds.length > 0) {
    return [...access.perWorld.values()].some((permissions) => has(permissions, key));
  }
  return existing.every((worldId) => has(access.perWorld.get(worldId)!, key));
}

/** The worlds where they have a permission: 'all' when it works in every world. */
export function worldsAllowing(access: Access, key: PermissionKey): 'all' | string[] {
  if (access.full || has(access.everywhere, key)) return 'all';
  return access.worldIds.filter((worldId) => has(access.perWorld.get(worldId) ?? ZERO, key));
}

/** Whether they rank above a role, so they may give, edit or delete it. */
export function ranksAbove(access: Access, role: { position: number }): boolean {
  return access.full || role.position < access.highest;
}

/** Whether every permission that changes between two numbers is one they have themselves. */
export function mayChangePermissions(access: Access, before: bigint, after: bigint): boolean {
  if (access.full || has(access.everywhere, 'ADMINISTRATOR')) return true;
  const changed = before ^ after;
  return (changed & ~access.everywhere) === ZERO;
}

/** What changes between two scopes, as a reach: going to or from "every world" reaches every world. */
export function scopeChange(before: WorldScope | null, after: WorldScope | null): Reach {
  const a = before ?? { allWorlds: false, worldIds: [] };
  const b = after ?? { allWorlds: false, worldIds: [] };
  if (a.allWorlds && b.allWorlds) return { allWorlds: false, worldIds: [] };
  if (a.allWorlds || b.allWorlds) return { allWorlds: true };
  const left = new Set(a.worldIds);
  const right = new Set(b.worldIds);
  return {
    allWorlds: false,
    worldIds: [...a.worldIds.filter((id) => !right.has(id)), ...b.worldIds.filter((id) => !left.has(id))],
  };
}

export function reachOf(scope: WorldScope): Reach {
  return scope.allWorlds ? { allWorlds: true } : { allWorlds: false, worldIds: scope.worldIds };
}

/** Whether a role carries Administrator, which can't be limited to some worlds. */
export function isAdministratorRole(role: { permissions: bigint | number | string }): boolean {
  return ((parsePermissions(role.permissions) ?? ZERO) & flag('ADMINISTRATOR')) !== ZERO;
}

/** Load someone's access to a universe. Null when the universe doesn't exist. */
export async function accessFor(
  db: Db,
  universeId: string,
  user: { id: string; isSuperAdmin?: boolean },
): Promise<Access | null> {
  const universe = await db.universe.findUnique({
    where: { id: universeId },
    select: { ownerId: true, worlds: { select: { id: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!universe) return null;
  const [base, membership] = await Promise.all([
    db.role.findMany({ where: { universeId, key: { in: [EVERYONE_KEY, MEMBER_KEY] } }, select: { key: true, permissions: true } }),
    db.universeMember.findUnique({
      where: { universeId_userId: { universeId, userId: user.id } },
      include: { roles: { include: { role: { select: { key: true, position: true, permissions: true } } } } },
    }),
  ]);
  const permissionsOf = (key: string) => parsePermissions(base.find((role) => role.key === key)?.permissions ?? 0) ?? ZERO;
  const isOwner = universe.ownerId === user.id;
  return computeAccess({
    universeId,
    worldIds: universe.worlds.map((world) => world.id),
    full: isOwner || !!user.isSuperAdmin,
    isOwner,
    everyone: permissionsOf(EVERYONE_KEY),
    member: permissionsOf(MEMBER_KEY),
    membership: membership ? { allWorlds: membership.allWorlds, worldIds: membership.worldIds } : null,
    roles: (membership?.roles ?? []).map((given) => ({
      key: given.role.key,
      position: given.role.position,
      permissions: parsePermissions(given.role.permissions) ?? ZERO,
      allWorlds: given.allWorlds,
      worldIds: given.worldIds,
    })),
  });
}

/** A universe's roles, highest first, ready for JSON (the permission number as a decimal string). */
export function roleForJson(role: {
  id: string;
  key: string;
  name: string;
  color: string;
  showBadge: boolean;
  permissions: bigint;
  position: number;
  builtIn: boolean;
}) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    color: role.color,
    showBadge: role.showBadge,
    permissions: role.permissions.toString(),
    position: role.position,
    builtIn: role.builtIn,
  };
}
