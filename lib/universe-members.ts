/**
 * Joining, leaving and changing someone's roles in a universe (#314). Every change ends with syncWorldMembers, so the
 * world_members rows (and their tags) that the rest of Orbit and the game read always match.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { isAdministratorRole } from '@/lib/role-access';
import { CUSTOM_MIN_POSITION, EVERYONE_KEY, MEMBER_KEY, ensureBuiltInRoles, syncWorldMembers, type WorldScope } from '@/lib/roles';

type Db = PrismaClient | Prisma.TransactionClient;

/** Two scopes together: every world either covers. */
export function unionScope(a: WorldScope, b: WorldScope): WorldScope {
  if (a.allWorlds || b.allWorlds) return { allWorlds: true, worldIds: [] };
  return { allWorlds: false, worldIds: [...new Set([...a.worldIds, ...b.worldIds])] };
}

/** A scope without one world. "Every world" becomes the list of the others. */
export function withoutWorld(scope: WorldScope, worldId: string, universeWorldIds: readonly string[]): WorldScope {
  const ids = scope.allWorlds ? universeWorldIds : scope.worldIds;
  return { allWorlds: false, worldIds: ids.filter((id) => id !== worldId) };
}

export function isEmptyScope(scope: WorldScope): boolean {
  return !scope.allWorlds && scope.worldIds.length === 0;
}

async function universeWorldIds(db: Db, universeId: string): Promise<string[]> {
  const worlds = await db.world.findMany({ where: { universeId }, select: { id: true } });
  return worlds.map((world) => world.id);
}

/**
 * The role for each tag, made if missing: tags given before roles could be any text, and a map area locked to one
 * still has to match. `member` and `everyone` need no role: every member is a Member.
 */
export async function roleIdsForTags(db: Db, universeId: string, tags: readonly string[]): Promise<string[]> {
  await ensureBuiltInRoles(db, universeId);
  const keys = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag && tag !== MEMBER_KEY && tag !== EVERYONE_KEY))];
  if (keys.length === 0) return [];
  const existing = await db.role.findMany({ where: { universeId, key: { in: keys } }, select: { id: true, key: true } });
  const missing = keys.filter((key) => !existing.some((role) => role.key === key));
  if (missing.length > 0) {
    // New ones rank lowest among the custom roles, so they never let anyone give a role they could not give before
    await db.role.updateMany({ where: { universeId, builtIn: false }, data: { position: { increment: missing.length } } });
    await db.role.createMany({
      data: missing.map((key, index) => ({ universeId, key, name: key, position: CUSTOM_MIN_POSITION + 1 + index })),
      skipDuplicates: true,
    });
  }
  const all = await db.role.findMany({ where: { universeId, key: { in: keys } }, select: { id: true } });
  return all.map((role) => role.id);
}

export interface JoinRequest {
  universeId: string;
  userId: string;
  /** Where they are a Member. */
  worlds: WorldScope;
  roles: { roleId: string; scope: WorldScope }[];
}

/**
 * Join a universe, or add to an existing membership: worlds and roles are added to what they already have, never
 * taken away.
 */
export async function joinUniverse(db: Db, request: JoinRequest): Promise<void> {
  const { universeId, userId } = request;
  await ensureBuiltInRoles(db, universeId);
  const existing = await db.universeMember.findUnique({
    where: { universeId_userId: { universeId, userId } },
    include: { roles: true },
  });
  const worlds = existing ? unionScope(existing, request.worlds) : request.worlds;
  const member = existing
    ? await db.universeMember.update({ where: { id: existing.id }, data: worlds })
    : await db.universeMember.create({ data: { universeId, userId, ...worlds } });

  const roles = await db.role.findMany({
    where: { universeId, id: { in: request.roles.map((given) => given.roleId) } },
    select: { id: true, key: true, permissions: true },
  });
  for (const given of request.roles) {
    const role = roles.find((candidate) => candidate.id === given.roleId);
    if (!role || role.key === MEMBER_KEY || role.key === EVERYONE_KEY || isEmptyScope(given.scope)) continue;
    const had = existing?.roles.find((row) => row.roleId === role.id);
    const scope = had ? unionScope(had, given.scope) : given.scope;
    // Administrator is never limited to some worlds: a role that gained it after being offered that way is not given
    if (!scope.allWorlds && isAdministratorRole(role)) continue;
    await db.universeMemberRole.upsert({
      where: { memberId_roleId: { memberId: member.id, roleId: role.id } },
      create: { memberId: member.id, roleId: role.id, ...scope },
      update: scope,
    });
  }
  await syncWorldMembers(db, universeId, userId);
}

/**
 * Set someone's tags in one world, the way the per-world member screens did before roles: each tag's role works in
 * this world from now on, and their other roles no longer do. Their roles in other worlds stay as they are.
 */
export async function setTagsInWorld(db: Db, worldId: string, userId: string, tags: readonly string[]): Promise<void> {
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { universeId: true } });
  const { universeId } = world;
  const wanted = new Set(await roleIdsForTags(db, universeId, tags));
  await joinUniverse(db, { universeId, userId, worlds: { allWorlds: false, worldIds: [worldId] }, roles: [] });

  const member = await db.universeMember.findUniqueOrThrow({
    where: { universeId_userId: { universeId, userId } },
    include: { roles: true },
  });
  const worldIds = await universeWorldIds(db, universeId);
  for (const row of member.roles) {
    if (wanted.has(row.roleId)) continue;
    if (!row.allWorlds && !row.worldIds.includes(worldId)) continue;
    const scope = withoutWorld(row, worldId, worldIds);
    if (isEmptyScope(scope)) await db.universeMemberRole.delete({ where: { id: row.id } });
    else await db.universeMemberRole.update({ where: { id: row.id }, data: scope });
  }
  const administrators = new Set(
    (await db.role.findMany({ where: { id: { in: [...wanted] } }, select: { id: true, permissions: true } }))
      .filter(isAdministratorRole)
      .map((role) => role.id),
  );
  for (const roleId of wanted) {
    const row = member.roles.find((candidate) => candidate.roleId === roleId);
    const scope = row ? unionScope(row, { allWorlds: false, worldIds: [worldId] }) : { allWorlds: false, worldIds: [worldId] };
    // A tag gives its role in one world, and Administrator is never limited to some worlds
    if (!scope.allWorlds && administrators.has(roleId)) continue;
    await db.universeMemberRole.upsert({
      where: { memberId_roleId: { memberId: member.id, roleId } },
      create: { memberId: member.id, roleId, ...scope },
      update: scope,
    });
  }
  await syncWorldMembers(db, universeId, userId);
}

/**
 * Take someone out of one world: their membership and every role of theirs stop working there. When no world is left,
 * they are no longer in the universe.
 */
export async function leaveWorld(db: Db, worldId: string, userId: string): Promise<void> {
  const world = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { universeId: true } });
  const { universeId } = world;
  const member = await db.universeMember.findUnique({
    where: { universeId_userId: { universeId, userId } },
    include: { roles: true },
  });
  if (member) {
    const worldIds = await universeWorldIds(db, universeId);
    for (const row of member.roles) {
      if (!row.allWorlds && !row.worldIds.includes(worldId)) continue;
      const scope = withoutWorld(row, worldId, worldIds);
      if (isEmptyScope(scope)) await db.universeMemberRole.delete({ where: { id: row.id } });
      else await db.universeMemberRole.update({ where: { id: row.id }, data: scope });
    }
    const scope = withoutWorld(member, worldId, worldIds);
    const remaining = await db.universeMemberRole.count({ where: { memberId: member.id } });
    if (isEmptyScope(scope) && remaining === 0) await db.universeMember.delete({ where: { id: member.id } });
    else await db.universeMember.update({ where: { id: member.id }, data: scope });
  }
  await syncWorldMembers(db, universeId, userId);
}

/** Take someone out of a universe: every role, every world. */
export async function leaveUniverse(db: Db, universeId: string, userId: string): Promise<void> {
  await db.universeMember.deleteMany({ where: { universeId, userId } });
  await syncWorldMembers(db, universeId, userId);
}
