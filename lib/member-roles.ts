/**
 * How the people screens (#314) show someone's roles: the highest role with a "+N" for the rest, where it works, and
 * which worlds a role may be ticked for. Pure, so both the pages and the tests use the same rules.
 */

export interface RoleInfo {
  id: string;
  key: string;
  name: string;
  color: string;
  badge?: string | null;
  builtIn?: boolean;
  /** The permission number as a decimal string. */
  permissions?: string;
}

export interface Worlds {
  allWorlds: boolean;
  worldIds: string[];
}

export interface MemberRoles {
  isOwner: boolean;
  worlds: Worlds;
  /** Highest first, as the members routes send them. */
  roles: { roleId: string; allWorlds: boolean; worldIds: string[] }[];
}

/** The owner's pill: not a role anyone is given, so it has its own colour. */
export const OWNER_PILL = { name: 'Owner', color: '#FACC15' };

/** "HQ only", "HQ and Campus", "3 worlds"; null when it works everywhere. */
export function worldsLabel(scope: Worlds, worldNames: ReadonlyMap<string, string>): string | null {
  if (scope.allWorlds) return null;
  const names = scope.worldIds.map((id) => worldNames.get(id)).filter((name): name is string => !!name);
  if (names.length === 0) return 'No worlds';
  if (names.length === 1) return `${names[0]} only`;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} worlds`;
}

export interface RoleSummary {
  name: string;
  color: string;
  badge: string | null;
  /** Where it works, when not everywhere. */
  where: string | null;
  /** How many more roles they hold, shown as "+N". */
  more: number;
}

/**
 * The one role a row shows: the owner's, else their highest custom or built-in role, else Member. The Member pill
 * appears only for someone with no other role.
 */
export function summariseRoles(
  member: MemberRoles,
  roles: ReadonlyMap<string, RoleInfo>,
  worldNames: ReadonlyMap<string, string>,
): RoleSummary {
  const held = member.roles.filter((given) => roles.has(given.roleId));
  if (member.isOwner) {
    return { ...OWNER_PILL, badge: null, where: null, more: held.length };
  }
  if (held.length === 0) {
    const base = [...roles.values()].find((role) => role.key === 'member');
    return {
      name: base?.name ?? 'Member',
      color: base?.color ?? '#A78BFA',
      badge: null,
      where: worldsLabel(member.worlds, worldNames),
      more: 0,
    };
  }
  const top = held[0];
  const role = roles.get(top.roleId) as RoleInfo;
  return { name: role.name, color: role.color, badge: role.badge ?? null, where: worldsLabel(top, worldNames), more: held.length - 1 };
}

/** What a list of allowed worlds says: every world, or only these. */
export type AllowedWorlds = 'all' | string[];

/**
 * The worlds a choice may name, given the worlds of the universe and each limit that applies (where they are a member,
 * where you may give roles, where you may invite). `all` is whether "All worlds" may be picked.
 */
export function pickableWorlds(universeWorldIds: readonly string[], ...limits: AllowedWorlds[]): { all: boolean; ids: string[] } {
  const all = limits.every((limit) => limit === 'all');
  const ids = universeWorldIds.filter((id) => limits.every((limit) => limit === 'all' || limit.includes(id)));
  return { all, ids };
}

/** The permission number of a role carries Administrator, which works in every world and can't be limited. */
export function isAdministrator(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    return (BigInt(permissions) & (BigInt(1) << BigInt(30))) !== BigInt(0);
  } catch {
    return false;
  }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "today", "yesterday", or the weekday ("Monday"); the sheet's list only reaches back a week. */
export function dayWord(date: Date, now: Date = new Date()): string {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return WEEKDAYS[date.getDay()];
}
