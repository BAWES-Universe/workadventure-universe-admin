/**
 * What someone may change about another member of a universe: which roles to give or take, where, and whether to take
 * them out. One place, so the member page and the card button in the game agree.
 */
import { allows, ranksAbove, worldsAllowing, type Access, type Reach } from '@/lib/role-access';

interface JoinedRoles {
  allWorlds: boolean;
  worldIds: string[];
  roles: { allWorlds: boolean; worldIds: string[]; role: { position: number } }[];
}

/** Every world someone is in: through their membership or any role. */
export function reachOfMember(member: JoinedRoles): Reach {
  if (member.allWorlds || member.roles.some((given) => given.allWorlds)) return { allWorlds: true };
  return { allWorlds: false, worldIds: [...new Set([...member.worldIds, ...member.roles.flatMap((given) => given.worldIds)])] };
}

/** The rank of a member: their highest role, Member at least. The owner is above every role. */
export function rankOfMember(member: JoinedRoles, isOwner: boolean): number {
  return isOwner ? Infinity : Math.max(1, ...member.roles.map((given) => given.role.position));
}

export interface MemberCan {
  /** The roles you may give or take away (below your own). */
  giveRoleIds: string[];
  /** The worlds where you may. */
  giveWorlds: 'all' | string[];
  /** "All worlds" on someone limited to some worlds adds them to every world: for whoever may add people everywhere. */
  widen: boolean;
  /** Taking them out of the universe: never the owner, only below you, and only where you may remove people. */
  remove: boolean;
}

export function memberCan(input: {
  access: Access;
  viewerId: string;
  userId: string;
  ownerId: string;
  member: JoinedRoles;
  /** The universe's roles that can be given: everything but Member and Everyone. */
  roles: { id: string; position: number }[];
}): MemberCan {
  const { access, viewerId, userId, ownerId, member, roles } = input;
  const isOwner = userId === ownerId;
  const theirHighest = rankOfMember(member, isOwner);
  const givable = worldsAllowing(access, 'GIVE_ROLES');
  // Someone else's roles are changed only from above them. The owner has every permission already: nothing to give.
  const canGiveAnywhere = !isOwner && (givable === 'all' || givable.length > 0) && (access.full || userId === viewerId || theirHighest < access.highest);
  return {
    giveRoleIds: canGiveAnywhere ? roles.filter((role) => ranksAbove(access, role)).map((role) => role.id) : [],
    giveWorlds: givable,
    widen: allows(access, 'INVITE_AND_REMOVE', { allWorlds: true }),
    // Leaving is yours
    remove:
      userId === viewerId
        ? !isOwner
        : !isOwner && (access.full || theirHighest < access.highest) && allows(access, 'INVITE_AND_REMOVE', reachOfMember(member)),
  };
}
