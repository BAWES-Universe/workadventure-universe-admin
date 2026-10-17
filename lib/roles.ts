/**
 * Roles (#314): one Roles list per universe, Discord style.
 *
 * Someone joins a universe once (UniverseMember). Everyone who joined is a Member, in the worlds their membership
 * names (all of them, or some), and every role they are given adds its own worlds. In each of those worlds they carry
 * the keys of their roles there, plus `member`, as tags.
 *
 * Release 1 keeps `world_members` filled from these rows (syncWorldMembers), so everything that reads a world
 * member's tags (map areas, avatar access, the game) keeps working unchanged while roles take over.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ALL_PERMISSIONS, combine, flag, has, parsePermissions } from '@/lib/permissions';

type Db = PrismaClient | Prisma.TransactionClient;

export const EVERYONE_KEY = 'everyone';
export const MEMBER_KEY = 'member';
export const EDITOR_KEY = 'editor';
export const ADMIN_KEY = 'admin';

/**
 * Where roles rank, highest first: Admin always above every custom role; Editor and Member below them; Everyone last.
 * Custom roles sit between CUSTOM_MIN_POSITION and ADMIN_POSITION, and are the only ones that can be dragged.
 */
export const ADMIN_POSITION = 1_000_000;
export const CUSTOM_MIN_POSITION = 10;
export const EDITOR_POSITION = 2;
export const MEMBER_POSITION = 1;
export const EVERYONE_POSITION = 0;

/** What the built-in Editor starts with: exactly what the `editor` tag allows today (world, rooms, maps, bots). */
export const EDITOR_DEFAULT_PERMISSIONS = combine(
  flag('MANAGE_WORLDS'),
  flag('MANAGE_ROOMS'),
  flag('EDIT_MAPS'),
  flag('MANAGE_BOTS'),
);

export interface BuiltInRole {
  key: string;
  name: string;
  color: string;
  permissions: bigint;
  position: number;
}

export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { key: ADMIN_KEY, name: 'Admin', color: '#F87171', permissions: ALL_PERMISSIONS, position: ADMIN_POSITION },
  { key: EDITOR_KEY, name: 'Editor', color: '#60A5FA', permissions: EDITOR_DEFAULT_PERMISSIONS, position: EDITOR_POSITION },
  { key: MEMBER_KEY, name: 'Member', color: '#A78BFA', permissions: BigInt(0), position: MEMBER_POSITION },
  { key: EVERYONE_KEY, name: 'Everyone', color: '#A3A3B5', permissions: BigInt(0), position: EVERYONE_POSITION },
];

export function isBuiltInKey(key: string): boolean {
  return BUILT_IN_ROLES.some((role) => role.key === key);
}

/** Where a membership or a role works: every world of the universe, or only the ones listed. */
export interface WorldScope {
  allWorlds: boolean;
  worldIds: string[];
}

export interface ScopedRole extends WorldScope {
  key: string;
  position: number;
  permissions: bigint;
}

/** The worlds a scope covers, among the universe's worlds (a world that has since been deleted is ignored). */
export function worldsOf(scope: WorldScope, universeWorldIds: readonly string[]): string[] {
  if (scope.allWorlds) return [...universeWorldIds];
  const listed = new Set(scope.worldIds);
  return universeWorldIds.filter((id) => listed.has(id));
}

export function coversWorld(scope: WorldScope, worldId: string): boolean {
  return scope.allWorlds || scope.worldIds.includes(worldId);
}

/**
 * The tags someone carries in each world they are in: the keys of their roles there, highest first, then `member`.
 * They are in a world when their membership or one of their roles works there.
 */
export function tagsByWorld(
  membership: WorldScope,
  roles: readonly ScopedRole[],
  universeWorldIds: readonly string[],
): Map<string, string[]> {
  const ranked = [...roles]
    .filter((role) => role.key !== MEMBER_KEY && role.key !== EVERYONE_KEY)
    .sort((a, b) => b.position - a.position || a.key.localeCompare(b.key));
  const worlds = new Set(worldsOf(membership, universeWorldIds));
  for (const role of ranked) for (const id of worldsOf(role, universeWorldIds)) worlds.add(id);

  const result = new Map<string, string[]>();
  for (const worldId of universeWorldIds) {
    if (!worlds.has(worldId)) continue;
    const keys = ranked.filter((role) => coversWorld(role, worldId)).map((role) => role.key);
    result.set(worldId, [...keys, MEMBER_KEY]);
  }
  return result;
}

/**
 * Someone's permissions in one world: Everyone's, plus Member's when they are in that world, plus every role of theirs
 * that works there. Administrator stands for everything.
 */
export function permissionsInWorld(
  worldId: string,
  everyone: bigint,
  membership: { scope: WorldScope; member: bigint; inWorld: boolean } | null,
  roles: readonly ScopedRole[],
): bigint {
  let permissions = everyone;
  if (membership?.inWorld) permissions |= membership.member;
  for (const role of roles) {
    if (coversWorld(role, worldId)) permissions |= role.permissions;
  }
  return has(permissions, 'ADMINISTRATOR') ? permissions | ALL_PERMISSIONS : permissions;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((tag) => set.has(tag));
}

/** Make sure a universe has its built-in roles. Safe to call any number of times. */
export async function ensureBuiltInRoles(db: Db, universeId: string): Promise<void> {
  await db.role.createMany({
    data: BUILT_IN_ROLES.map((role) => ({
      universeId,
      key: role.key,
      name: role.name,
      color: role.color,
      permissions: role.permissions,
      position: role.position,
      builtIn: true,
    })),
    skipDuplicates: true,
  });
}

/**
 * Bring one person's world_members rows in line with their universe membership and roles: a row for every world they
 * are in, carrying their tags there, and none elsewhere in the universe. A row that is already right is left alone,
 * so its joined date stays.
 */
export async function syncWorldMembers(db: Db, universeId: string, userId: string): Promise<void> {
  const [worlds, membership] = await Promise.all([
    db.world.findMany({ where: { universeId }, select: { id: true }, orderBy: { createdAt: 'asc' } }),
    db.universeMember.findUnique({
      where: { universeId_userId: { universeId, userId } },
      include: { roles: { include: { role: { select: { key: true, position: true, permissions: true } } } } },
    }),
  ]);
  const worldIds = worlds.map((world) => world.id);
  const wanted = membership
    ? tagsByWorld(
        membership,
        membership.roles.map((given) => ({
          key: given.role.key,
          position: given.role.position,
          permissions: given.role.permissions,
          allWorlds: given.allWorlds,
          worldIds: given.worldIds,
        })),
        worldIds,
      )
    : new Map<string, string[]>();

  const existing = await db.worldMember.findMany({
    where: { userId, worldId: { in: worldIds } },
    select: { id: true, worldId: true, tags: true },
  });
  const existingByWorld = new Map(existing.map((row) => [row.worldId, row]));

  const stale = existing.filter((row) => !wanted.has(row.worldId)).map((row) => row.id);
  if (stale.length > 0) await db.worldMember.deleteMany({ where: { id: { in: stale } } });

  for (const [worldId, tags] of wanted) {
    const row = existingByWorld.get(worldId);
    if (!row) {
      await db.worldMember.create({
        data: { userId, worldId, tags, ...(membership ? { joinedAt: membership.joinedAt } : {}) },
      });
    } else if (!sameTags(row.tags, tags)) {
      await db.worldMember.update({ where: { id: row.id }, data: { tags } });
    }
  }
}

/** After a world is created: everyone whose membership or a role works in every world is now in it too. */
export async function syncNewWorld(db: Db, universeId: string): Promise<void> {
  const members = await db.universeMember.findMany({
    where: { universeId, OR: [{ allWorlds: true }, { roles: { some: { allWorlds: true } } }] },
    select: { userId: true },
  });
  for (const member of members) await syncWorldMembers(db, universeId, member.userId);
}

/** What today's tags allow, the way the game reads them when Orbit sends no permission number. */
export function permissionsFromTags(tags: readonly string[]): bigint {
  let permissions = BigInt(0);
  if (tags.includes(ADMIN_KEY)) permissions |= ALL_PERMISSIONS;
  if (tags.includes(EDITOR_KEY)) permissions |= EDITOR_DEFAULT_PERMISSIONS;
  return permissions;
}

/**
 * Someone's permission number in one world, for the game: Everyone's, Member's when they are in it, and their roles
 * that work there. A person with no account (a guest) gets Everyone's. Owning the universe adds nothing here: in the
 * game an owner has the roles they hold, as today. A world member with no universe membership (a row written some
 * other way) is read from their tags, so they never lose what the tags give them.
 */
export async function permissionsForWorld(
  place: { userId: string | null; worldId: string; universeId: string; worldTags?: readonly string[] },
  db: Db = prisma,
): Promise<bigint> {
  const { userId, worldId, universeId, worldTags = [] } = place;
  const [everyone, member] = await Promise.all([
    db.role.findUnique({ where: { universeId_key: { universeId, key: EVERYONE_KEY } } }),
    db.role.findUnique({ where: { universeId_key: { universeId, key: MEMBER_KEY } } }),
  ]);
  const everyonePermissions = parsePermissions(everyone?.permissions ?? 0) ?? BigInt(0);
  if (!userId) return permissionsInWorld(worldId, everyonePermissions, null, []);

  const membership = await db.universeMember.findUnique({
    where: { universeId_userId: { universeId, userId } },
    include: { roles: { include: { role: { select: { key: true, position: true, permissions: true } } } } },
  });
  if (!membership) {
    return permissionsInWorld(worldId, everyonePermissions | permissionsFromTags(worldTags), null, []);
  }

  const roles: ScopedRole[] = membership.roles.map((given) => ({
    key: given.role.key,
    position: given.role.position,
    permissions: parsePermissions(given.role.permissions) ?? BigInt(0),
    allWorlds: given.allWorlds,
    worldIds: given.worldIds,
  }));
  const inWorld = coversWorld(membership, worldId) || roles.some((role) => coversWorld(role, worldId));
  return permissionsInWorld(
    worldId,
    everyonePermissions,
    { scope: membership, member: parsePermissions(member?.permissions ?? 0) ?? BigInt(0), inWorld },
    roles,
  );
}
