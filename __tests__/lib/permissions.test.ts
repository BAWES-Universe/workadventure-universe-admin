import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  combine,
  flag,
  fromKeys,
  has,
  keysOf,
  parsePermissions,
  toWire,
  withUniverse,
} from '@/lib/permissions';

describe('role permissions', () => {
  it('keeps every bit where the game and saved roles expect it', () => {
    // These numbers are stored and sent to the game: changing one breaks both
    expect(Object.fromEntries(PERMISSIONS.map((info) => [info.key, info.bit]))).toEqual({
      GIVE_ROLES: 0,
      MANAGE_ROLES: 1,
      INVITE_AND_REMOVE: 2,
      BAN_AND_APPEALS: 3,
      KICK_FROM_ROOM: 4,
      MANAGE_WORLDS: 5,
      MANAGE_ROOMS: 6,
      EDIT_MAPS: 7,
      GO_LIVE: 8,
      SEND_MESSAGES: 9,
      REACH_UNIVERSE: 10,
      MODERATE_CALLS: 11,
      MODERATE_AREA_CHATS: 12,
      MANAGE_BOTS: 13,
      CHAT_BOTS_NEARBY: 14,
      DM_BOTS: 15,
      SUMMON_BOTS: 16,
      BOTS_CHANGE_THINGS: 17,
      BOTS_DELETE_OR_SEND: 18,
      ADMINISTRATOR: 30,
    });
    expect(new Set(PERMISSIONS.map((info) => info.bit)).size).toBe(PERMISSIONS.length);
  });

  it('has 19 permissions plus Administrator, and Admin gets all 19', () => {
    expect(ALL_PERMISSIONS).toBe(BigInt(524287));
    expect(has(ALL_PERMISSIONS, 'ADMINISTRATOR')).toBe(false);
  });

  it('merges roles the way Discord does: a permission any of them has', () => {
    const merged = combine(flag('EDIT_MAPS'), flag('GO_LIVE'), flag('EDIT_MAPS'));
    expect(keysOf(merged)).toEqual(['EDIT_MAPS', 'GO_LIVE']);
    expect(merged).toBe(fromKeys(['GO_LIVE', 'EDIT_MAPS']));
  });

  it('treats Administrator as every permission', () => {
    const administrator = flag('ADMINISTRATOR');
    expect(PERMISSIONS.every((info) => has(administrator, info.key))).toBe(true);
  });

  it('reads numbers, numeric strings and bigints, drops unknown bits and refuses anything else', () => {
    expect(parsePermissions('8416')).toBe(BigInt(8416));
    expect(parsePermissions(128)).toBe(BigInt(128));
    expect(parsePermissions(BigInt(1) << BigInt(30))).toBe(flag('ADMINISTRATOR'));
    expect(parsePermissions(String((BigInt(1) << BigInt(40)) | BigInt(1)))).toBe(BigInt(1));
    for (const bad of [-1, 1.5, '12a', '', '-3', null, undefined, {}, Number.MAX_VALUE]) {
      expect(parsePermissions(bad)).toBeNull();
    }
  });

  it('sends the number as a decimal string', () => {
    expect(toWire(flag('ADMINISTRATOR') | flag('GIVE_ROLES'))).toBe('1073741825');
  });

  it('puts the universe name in labels', () => {
    const reach = PERMISSIONS.find((info) => info.key === 'REACH_UNIVERSE')!;
    expect(withUniverse(reach.label, 'BAWES')).toBe('Reach all of BAWES');
  });
});
