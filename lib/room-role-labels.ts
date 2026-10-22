/**
 * The role names the game needs to show a badge next to people (#1228). Tags already reach the game as role keys;
 * this says what each key is called, what colour it is, and whether the badge may be shown on other people.
 *
 * Roles whose badge is switched off are only named to people who manage roles or give roles (they see them on others,
 * as on the Orbit pages) and to the people who hold them, so the game can show someone their own. Everyone else
 * never learns that such a role exists. Member and Everyone are never listed: Member is automatic for everyone.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { accessFor } from '@/lib/role-access';
import { seesHiddenRoles } from '@/lib/universe-route';
import { EVERYONE_KEY, MEMBER_KEY } from '@/lib/roles';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RoleLabel {
  key: string;
  name: string;
  color: string;
  /** False: show it only on the person who holds it (and to people who manage roles). */
  visibleOnOthers: boolean;
}

interface RoleRow {
  key: string;
  name: string;
  color: string;
  showBadge: boolean;
  position: number;
}

/** The roles to name for one viewer, highest first. Pure, so the hiding rule can be tested without a database. */
export function roleLabelsFor(roles: readonly RoleRow[], viewer: { seesHidden: boolean; tags: readonly string[] }): RoleLabel[] {
  return [...roles]
    .filter((role) => role.key !== MEMBER_KEY && role.key !== EVERYONE_KEY)
    .filter((role) => role.showBadge || viewer.seesHidden || viewer.tags.includes(role.key))
    .sort((a, b) => b.position - a.position || a.key.localeCompare(b.key))
    .map((role) => ({
      key: role.key,
      name: role.name,
      color: role.color,
      visibleOnOthers: role.showBadge || viewer.seesHidden,
    }));
}

/** The roles of a universe as one viewer may see them. A guest (no account) sees only the ones with a badge. */
export async function roleLabelsForViewer(
  db: Db,
  universeId: string,
  viewer: { user: { id: string; isSuperAdmin?: boolean } | null; tags: readonly string[] },
): Promise<RoleLabel[]> {
  const [roles, access] = await Promise.all([
    db.role.findMany({
      where: { universeId, key: { notIn: [MEMBER_KEY, EVERYONE_KEY] } },
      select: { key: true, name: true, color: true, showBadge: true, position: true },
    }),
    viewer.user ? accessFor(db, universeId, viewer.user) : Promise.resolve(null),
  ]);
  return roleLabelsFor(roles, { seesHidden: !!access && seesHiddenRoles(access), tags: viewer.tags });
}
