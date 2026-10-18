/**
 * What the Roles & permissions screens need to know that is not in a route (#314): the shapes the role routes send, the
 * templates a new role can start from, the colours on offer, which permissions the viewer may switch, and the short
 * line a role's row shows. Pure, so it is tested without a screen.
 */
import {
  PERMISSIONS,
  flag,
  has,
  parsePermissions,
  withUniverse,
  type PermissionKey,
} from '@/lib/permissions';

const ZERO = BigInt(0);

/** One role as GET /api/admin/universes/[id]/roles sends it. */
export interface RoleRow {
  id: string;
  key: string;
  name: string;
  color: string;
  showBadge: boolean;
  /** Decimal string. */
  permissions: string;
  position: number;
  builtIn: boolean;
  /** null for Everyone, which is everybody. */
  people: number | null;
  canEdit: boolean;
}

export interface RolesResponse {
  roles: RoleRow[];
  canManageRoles: boolean;
  /** Manage roles in every world and a role above Editor: what making a role (or a copy) asks. */
  canCreateRoles: boolean;
  canGiveRoles: 'all' | string[];
}

/** GET /api/admin/universes/[id]/me */
export interface MeResponse {
  isOwner: boolean;
  full: boolean;
  inUniverse: boolean;
  /** null when `full`. */
  highestPosition: number | null;
  everywhere: string;
  perWorld: Record<string, string>;
  canManageRoles: boolean;
  giveWorlds: 'all' | string[];
  inviteWorlds: 'all' | string[];
}

export interface WorldRef {
  id: string;
  name: string;
}

export function permissionsOf(role: Pick<RoleRow, 'permissions'>): bigint {
  return parsePermissions(role.permissions) ?? ZERO;
}

/** The colours a role can wear (the badge colour in lists). */
export const ROLE_COLOURS: readonly { value: string; name: string }[] = [
  { value: '#F87171', name: 'Red' },
  { value: '#FB923C', name: 'Orange' },
  { value: '#EAC54F', name: 'Yellow' },
  { value: '#34D399', name: 'Green' },
  { value: '#2DD4BF', name: 'Teal' },
  { value: '#38BDF8', name: 'Sky' },
  { value: '#60A5FA', name: 'Blue' },
  { value: '#A78BFA', name: 'Violet' },
  { value: '#F472B6', name: 'Pink' },
  { value: '#94A3B8', name: 'Grey' },
];

/** A colour not worn by a role yet, so new roles start apart; the first one when all are taken. */
export function freshColour(taken: readonly string[]): string {
  const used = new Set(taken.map((colour) => colour.toLowerCase()));
  return (ROLE_COLOURS.find((colour) => !used.has(colour.value.toLowerCase())) ?? ROLE_COLOURS[1]).value;
}

export type RoleTemplateId = 'blank' | 'moderator' | 'host' | 'builder';

export interface RoleTemplate {
  id: RoleTemplateId;
  title: string;
  description: string;
  keys: PermissionKey[];
}

/** What "Start from" offers when making a role. "Copy a role" is the fifth choice and is not a template. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: 'blank',
    title: 'Blank',
    description: 'No permissions. Use it for a team, a department or a level like Member level 2, and open rooms to it.',
    keys: [],
  },
  {
    id: 'moderator',
    title: 'Moderator',
    description: 'Moderate calls, kick from rooms, ban and moderate area chats.',
    keys: ['MODERATE_CALLS', 'KICK_FROM_ROOM', 'BAN_AND_APPEALS', 'MODERATE_AREA_CHATS'],
  },
  {
    id: 'host',
    title: 'Host',
    description: 'Go live and send Broadcast messages and voice notes.',
    keys: ['GO_LIVE', 'SEND_MESSAGES'],
  },
  {
    id: 'builder',
    title: 'Builder',
    description: 'Edit maps and create rooms.',
    keys: ['EDIT_MAPS', 'MANAGE_ROOMS'],
  },
];

/** What the viewer has, for deciding which switches they may move. */
export interface Viewer {
  /** The owner or a super admin. */
  full: boolean;
  /** Their permissions in every world. */
  everywhere: bigint;
  canManageRoles: boolean;
}

export function viewerFrom(me: MeResponse): Viewer {
  return { full: me.full, everywhere: parsePermissions(me.everywhere) ?? ZERO, canManageRoles: me.canManageRoles };
}

/** Whether the viewer has a permission themselves (they cannot hand out one they lack). */
export function viewerHas(viewer: Viewer, key: PermissionKey): boolean {
  return viewer.full || has(viewer.everywhere, key);
}

/** The first permission in a number that the viewer lacks, or null when they have them all. */
export function firstMissing(viewer: Viewer, permissions: bigint): PermissionKey | null {
  if (viewer.full || has(viewer.everywhere, 'ADMINISTRATOR')) return null;
  for (const info of PERMISSIONS) {
    if ((permissions & flag(info.key)) !== ZERO && (viewer.everywhere & flag(info.key)) === ZERO) return info.key;
  }
  return null;
}

/** "Needs Edit maps" for a permission the viewer lacks, written the way refusals are. */
export function needsLabel(key: PermissionKey, universeName: string): string {
  const info = PERMISSIONS.find((item) => item.key === key);
  return `Needs ${withUniverse(info?.label ?? key, universeName)}`;
}

/** Why a whole role cannot be edited by this viewer, or null when they can. */
export function roleLockReason(role: Pick<RoleRow, 'key' | 'builtIn' | 'name' | 'canEdit'>, viewer: Viewer): string | null {
  if (role.canEdit) return null;
  return viewer.canManageRoles ? `Needs a role above ${role.name}` : 'Needs Manage roles in every world';
}

/**
 * Why one permission's switch is locked, or null when the viewer can move it. Whole-role reasons win; then Admin's
 * fixed set; then Administrator (which includes the rest); then a permission the viewer lacks.
 */
export function permissionLockReason(
  role: Pick<RoleRow, 'key' | 'builtIn' | 'name' | 'canEdit'>,
  viewer: Viewer,
  draft: bigint,
  key: PermissionKey,
  universeName: string,
): string | null {
  if (role.builtIn && role.key === 'admin') return 'Admin always has every permission';
  const whole = roleLockReason(role, viewer);
  if (whole) return whole;
  if (key !== 'ADMINISTRATOR' && (draft & flag('ADMINISTRATOR')) !== ZERO) return 'Included in Administrator';
  if (!viewerHas(viewer, key)) return needsLabel(key, universeName);
  return null;
}

/** How many of the everyday permissions a number allows (Administrator allows all of them). */
export function countOn(permissions: bigint): number {
  return PERMISSIONS.filter((info) => info.key !== 'ADMINISTRATOR' && has(permissions, info.key)).length;
}

export const PERMISSION_TOTAL = PERMISSIONS.filter((info) => info.key !== 'ADMINISTRATOR').length;

/** How many permissions differ between two numbers. */
export function changedCount(a: bigint, b: bigint): number {
  const changed = a ^ b;
  return PERMISSIONS.filter((info) => (changed & flag(info.key)) !== ZERO).length;
}

/** The short names a role's row lists, in the order the page lists permissions. */
const SHORT: Record<PermissionKey, string> = {
  GIVE_ROLES: 'give roles',
  MANAGE_ROLES: 'manage roles',
  INVITE_AND_REMOVE: 'invite and remove people',
  BAN_AND_APPEALS: 'ban',
  KICK_FROM_ROOM: 'kick from rooms',
  MANAGE_WORLDS: 'edit worlds',
  MANAGE_ROOMS: 'edit rooms',
  EDIT_MAPS: 'edit maps',
  GO_LIVE: 'go live',
  SEND_MESSAGES: 'send messages',
  REACH_UNIVERSE: 'reach the universe',
  MODERATE_CALLS: 'moderate calls',
  MODERATE_AREA_CHATS: 'moderate area chats',
  MANAGE_BOTS: 'manage bots',
  CHAT_BOTS_NEARBY: 'chat with bots nearby',
  DM_BOTS: 'DM bots',
  SUMMON_BOTS: 'summon bots',
  ADMINISTRATOR: 'administrator',
};

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Moderate calls, kick from rooms, ban", or how many when there are many. */
export function permissionSummary(permissions: bigint): string {
  const keys = PERMISSIONS.filter((info) => (permissions & flag(info.key)) !== ZERO).map((info) => info.key);
  if (keys.includes('ADMINISTRATOR')) return 'Administrator: every permission';
  if (keys.length === 0) return 'No extra permissions';
  if (keys.length === PERMISSION_TOTAL) return `All ${PERMISSION_TOTAL} permissions`;
  if (keys.length > 4) return `${keys.length} permissions`;
  return sentence(keys.map((key) => SHORT[key]).join(', '));
}

export function peopleLabel(people: number | null): string | null {
  if (people === null) return null;
  return `${people.toLocaleString()} ${people === 1 ? 'person' : 'people'}`;
}

/** The line under a role's name in the list. */
export function roleLine(role: Pick<RoleRow, 'key' | 'builtIn' | 'people' | 'permissions'>): string {
  const permissions = permissionSummary(permissionsOf(role));
  if (role.builtIn && role.key === 'everyone') return `Every visitor · ${permissions}`;
  if (role.builtIn && role.key === 'member') return [peopleLabel(role.people), 'Everyone who joined, given automatically'].filter(Boolean).join(' · ');
  return [peopleLabel(role.people), permissions].filter(Boolean).join(' · ');
}

/** The built-in roles in the order the page lists them: who everyone is first, then the tiers. */
export const BUILT_IN_ORDER = ['everyone', 'admin', 'editor', 'member'];

export function builtInRoles(roles: readonly RoleRow[]): RoleRow[] {
  return roles
    .filter((role) => role.builtIn)
    .sort((a, b) => BUILT_IN_ORDER.indexOf(a.key) - BUILT_IN_ORDER.indexOf(b.key));
}

/** Custom roles, highest first. */
export function customRoles(roles: readonly RoleRow[]): RoleRow[] {
  return roles.filter((role) => !role.builtIn).sort((a, b) => b.position - a.position);
}

/**
 * The custom roles this viewer may move: they need Manage roles in every world (the order is saved for the whole
 * universe) and rank above the role. Without Manage roles nothing moves.
 */
export function movableRoles(roles: readonly RoleRow[], me: Pick<MeResponse, 'full' | 'highestPosition' | 'canManageRoles'>): RoleRow[] {
  if (!me.canManageRoles) return [];
  return customRoles(roles).filter((role) => me.full || (me.highestPosition !== null && role.position < me.highestPosition));
}

/**
 * Whether the viewer sees who holds a role whose badge is hidden: people who change the Roles list or give roles
 * somewhere (the server's rule for hiding them from everyone else).
 */
export function seesHiddenRoles(me: Pick<MeResponse, 'full' | 'canManageRoles' | 'giveWorlds'>): boolean {
  return me.full || me.canManageRoles || me.giveWorlds === 'all' || me.giveWorlds.length > 0;
}

/** A role the viewer may give to people: below theirs, and only custom, Admin and Editor can be given. */
export function canGiveRole(role: Pick<RoleRow, 'key' | 'builtIn' | 'position'>, me: Pick<MeResponse, 'full' | 'highestPosition' | 'giveWorlds'>): boolean {
  if (role.builtIn && (role.key === 'member' || role.key === 'everyone')) return false;
  const some = me.giveWorlds === 'all' || me.giveWorlds.length > 0;
  if (!some) return false;
  return me.full || (me.highestPosition !== null && role.position < me.highestPosition);
}

/** Where a person has a role: "Everywhere", "HQ only" or "HQ, Campus". */
export function scopeLabel(scope: { allWorlds: boolean; worldIds: string[] }, worlds: readonly WorldRef[]): string {
  if (scope.allWorlds) return 'Everywhere';
  const names = scope.worldIds.map((id) => worlds.find((world) => world.id === id)?.name).filter((name): name is string => !!name);
  if (names.length === 0) return 'No world';
  return names.length === 1 ? `${names[0]} only` : names.join(', ');
}
