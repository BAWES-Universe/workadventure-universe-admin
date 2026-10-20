/**
 * Role permissions (#314). A role keeps its permissions as one number; each permission is one bit of it. The bits are
 * fixed forever: a saved role, and the game reading the number, rely on them. Never reuse or move a bit; add new ones
 * at the next free bit.
 *
 * The number travels as a decimal string (JSON has no 64-bit integers), and is worked with as a bigint so a bit past
 * 31 never flips the sign or loses precision.
 */

// The app targets ES2017, which has no bigint literals.
const ZERO = BigInt(0);
const ONE = BigInt(1);

export type PermissionKey =
  | 'GIVE_ROLES'
  | 'MANAGE_ROLES'
  | 'INVITE_AND_REMOVE'
  | 'BAN_AND_APPEALS'
  | 'KICK_FROM_ROOM'
  | 'MANAGE_WORLDS'
  | 'MANAGE_ROOMS'
  | 'EDIT_MAPS'
  | 'GO_LIVE'
  | 'SEND_MESSAGES'
  | 'REACH_UNIVERSE'
  | 'MODERATE_CALLS'
  | 'MODERATE_AREA_CHATS'
  | 'MANAGE_BOTS'
  | 'CHAT_BOTS_NEARBY'
  | 'DM_BOTS'
  | 'SUMMON_BOTS'
  | 'ADMINISTRATOR';

export type PermissionGroup = 'people' | 'places' | 'broadcast' | 'calls' | 'bots' | 'owner';

export interface PermissionInfo {
  key: PermissionKey;
  bit: number;
  group: PermissionGroup;
  label: string;
  /** What it lets someone do, in the words the Roles & permissions page shows. `{universe}` is the universe's name. */
  description: string;
}

export const PERMISSIONS: readonly PermissionInfo[] = [
  { key: 'GIVE_ROLES', bit: 0, group: 'people', label: 'Give roles', description: 'Give and take away roles below their own.' },
  { key: 'MANAGE_ROLES', bit: 1, group: 'people', label: 'Manage roles', description: 'Create, edit and rank roles below their own.' },
  { key: 'INVITE_AND_REMOVE', bit: 2, group: 'people', label: 'Invite and remove people', description: 'Add people to {universe} or take them out.' },
  { key: 'BAN_AND_APPEALS', bit: 3, group: 'people', label: 'Ban and answer appeals', description: 'Keep someone out of a world or all of {universe}, and decide their appeal.' },
  { key: 'KICK_FROM_ROOM', bit: 4, group: 'people', label: 'Kick from a room', description: 'Send someone out of the room they are in. They can come back.' },
  { key: 'MANAGE_WORLDS', bit: 5, group: 'places', label: 'Create and edit worlds', description: 'Name, picture and visibility. If the role is limited to some worlds, only those worlds, and no new ones.' },
  { key: 'MANAGE_ROOMS', bit: 6, group: 'places', label: 'Create and edit rooms', description: 'Add rooms and change their settings.' },
  { key: 'EDIT_MAPS', bit: 7, group: 'places', label: 'Edit maps', description: 'Open the map editor and drop files onto the map. Also gets into every map area and can speak on every stage, so the area can be edited. Dropping a file outside the map editor sends it to chat, which anyone can do.' },
  { key: 'GO_LIVE', bit: 8, group: 'broadcast', label: 'Go live', description: 'Talk live with camera, mic or screen to everyone in the room. Each room can still open this to everyone, and choose whether a live talk reaches only the room or the whole world.' },
  { key: 'SEND_MESSAGES', bit: 9, group: 'broadcast', label: 'Send messages and voice notes', description: 'A Broadcast card everyone sees, or a voice note everyone hears.' },
  { key: 'REACH_UNIVERSE', bit: 10, group: 'broadcast', label: 'Reach all of {universe}', description: 'Go live or send a message to every world in the universe.' },
  { key: 'MODERATE_CALLS', bit: 11, group: 'calls', label: 'Moderate calls', description: "Mute someone's mic or camera without asking, mute everyone, lower hands, bring people on stage or send them back, remove someone from a call, and lead every Jitsi and BigBlueButton meeting. Anyone in a call can still ask someone to mute, and they can say no." },
  { key: 'MODERATE_AREA_CHATS', bit: 12, group: 'calls', label: 'Moderate area chats', description: 'Moderator in the chat of every map area: delete messages and remove people from it.' },
  { key: 'MANAGE_BOTS', bit: 13, group: 'bots', label: 'Manage bots', description: 'Create bots, change what they say and where they stand.' },
  { key: 'CHAT_BOTS_NEARBY', bit: 14, group: 'bots', label: 'Chat with bots nearby', description: 'Lets people walk up to a bot on the map and chat in its bubble. Everyone in the bubble sees it.' },
  { key: 'DM_BOTS', bit: 15, group: 'bots', label: 'DM bots', description: 'Lets signed-in people chat privately with a bot, one to one, from anywhere. Only they and the bot see it.' },
  { key: 'SUMMON_BOTS', bit: 16, group: 'bots', label: 'Summon bots', description: 'Lets people, including guests, summon a bot to them in its own room.' },
  { key: 'ADMINISTRATOR', bit: 30, group: 'owner', label: 'Administrator', description: "Like owning {universe}: all permissions in every world, gets past every room and area rule, and can't be limited to some worlds." },
];

export const PERMISSION_GROUPS: readonly { group: PermissionGroup; label: string }[] = [
  { group: 'people', label: 'People' },
  { group: 'places', label: 'Places' },
  { group: 'broadcast', label: 'Broadcast' },
  { group: 'calls', label: 'Calls and chat' },
  { group: 'bots', label: 'Bots' },
  { group: 'owner', label: 'Owner level' },
];

const BY_KEY = new Map(PERMISSIONS.map((info) => [info.key, info]));

/** The bit for one permission, as a number with only that bit set. */
export function flag(key: PermissionKey): bigint {
  const info = BY_KEY.get(key);
  if (!info) throw new Error(`Unknown permission ${key}`);
  return ONE << BigInt(info.bit);
}

/** Every permission except Administrator: what the built-in Admin role has. */
export const ALL_PERMISSIONS: bigint = PERMISSIONS.filter((info) => info.key !== 'ADMINISTRATOR').reduce(
  (all, info) => all | (ONE << BigInt(info.bit)),
  ZERO,
);

/** Every bit we know, Administrator included. Anything else in a saved or sent number is dropped. */
export const KNOWN_PERMISSIONS: bigint = ALL_PERMISSIONS | flag('ADMINISTRATOR');

/** One number from several, the way Discord merges roles: a permission any of them has. */
export function combine(...values: bigint[]): bigint {
  return values.reduce((all, value) => all | value, ZERO);
}

/** Whether a permission number allows something. Administrator allows everything. */
export function has(permissions: bigint, key: PermissionKey): boolean {
  if (permissions & flag('ADMINISTRATOR')) return true;
  return (permissions & flag(key)) !== ZERO;
}

/** Every permission a number allows, in the order the page lists them. Administrator expands to all of them. */
export function keysOf(permissions: bigint): PermissionKey[] {
  return PERMISSIONS.filter((info) => has(permissions, info.key)).map((info) => info.key);
}

export function fromKeys(keys: readonly PermissionKey[]): bigint {
  return combine(...keys.map(flag));
}

/**
 * Read a permission number from a request or the database. Accepts a bigint, a safe integer or a decimal string, and
 * keeps only known bits. Anything else (negative, fractional, too large, not a number) is null.
 */
export function parsePermissions(value: unknown): bigint | null {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    parsed = BigInt(value);
  } else {
    return null;
  }
  if (parsed < ZERO) return null;
  return parsed & KNOWN_PERMISSIONS;
}

export function toWire(permissions: bigint): string {
  return permissions.toString();
}

/** A permission's label or description with the universe's name in it. */
export function withUniverse(text: string, universeName: string): string {
  return text.replaceAll('{universe}', universeName);
}
