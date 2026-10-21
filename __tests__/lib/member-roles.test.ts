import { dayWord, isAdministrator, pickableWorlds, rolePickableWorlds, summariseRoles, worldsLabel, type RoleInfo } from '@/lib/member-roles';

const role = (id: string, key: string, name: string, color = '#ffffff'): RoleInfo => ({ id, key, name, color });
const ROLES = new Map<string, RoleInfo>([
  ['member', role('member', 'member', 'Member', '#A78BFA')],
  ['admin', role('admin', 'admin', 'Admin', '#F87171')],
  ['acct', role('acct', 'accountant', 'Accountant', '#34D399')],
]);
const WORLDS = new Map([['hq', 'HQ'], ['campus', 'Campus'], ['lab', 'Lab']]);
const everywhere = { allWorlds: true, worldIds: [] };

describe('worldsLabel', () => {
  it('says nothing when it works everywhere, and names the worlds otherwise', () => {
    expect(worldsLabel(everywhere, WORLDS)).toBeNull();
    expect(worldsLabel({ allWorlds: false, worldIds: ['hq'] }, WORLDS)).toBe('HQ only');
    expect(worldsLabel({ allWorlds: false, worldIds: ['hq', 'campus'] }, WORLDS)).toBe('HQ and Campus');
    expect(worldsLabel({ allWorlds: false, worldIds: ['hq', 'campus', 'lab'] }, WORLDS)).toBe('3 worlds');
  });
});

describe('summariseRoles', () => {
  it('shows the Member pill only for someone with no other role', () => {
    const plain = summariseRoles({ isOwner: false, worlds: everywhere, roles: [] }, ROLES, WORLDS);
    expect(plain).toMatchObject({ name: 'Member', more: 0, where: null });
    const withRole = summariseRoles({ isOwner: false, worlds: everywhere, roles: [{ roleId: 'acct', ...everywhere }] }, ROLES, WORLDS);
    expect(withRole.name).toBe('Accountant');
  });

  it('shows the highest role, where it works, and +N for the rest', () => {
    const summary = summariseRoles(
      { isOwner: false, worlds: everywhere, roles: [{ roleId: 'admin', allWorlds: false, worldIds: ['hq'] }, { roleId: 'acct', ...everywhere }] },
      ROLES,
      WORLDS,
    );
    expect(summary).toMatchObject({ name: 'Admin', color: '#F87171', where: 'HQ only', more: 1 });
  });

  it('puts the owner first, whatever roles they hold', () => {
    expect(summariseRoles({ isOwner: true, worlds: everywhere, roles: [] }, ROLES, WORLDS)).toMatchObject({ name: 'Owner', more: 0 });
  });

  it('says where a Member works when they are in some worlds only', () => {
    const summary = summariseRoles({ isOwner: false, worlds: { allWorlds: false, worldIds: ['campus'] }, roles: [] }, ROLES, WORLDS);
    expect(summary).toMatchObject({ name: 'Member', where: 'Campus only' });
  });
});

describe('pickableWorlds', () => {
  const all = ['hq', 'campus', 'lab'];
  it('allows every world only when every limit does', () => {
    expect(pickableWorlds(all, 'all', 'all')).toEqual({ all: true, ids: all });
    expect(pickableWorlds(all, 'all', ['hq', 'lab'])).toEqual({ all: false, ids: ['hq', 'lab'] });
    expect(pickableWorlds(all, ['hq', 'campus'], ['campus', 'lab'])).toEqual({ all: false, ids: ['campus'] });
    expect(pickableWorlds(all, [])).toEqual({ all: false, ids: [] });
  });
});

describe('isAdministrator', () => {
  it('reads bit 30 of the permission number', () => {
    expect(isAdministrator((BigInt(1) << BigInt(30)).toString())).toBe(true);
    expect(isAdministrator('16383')).toBe(false);
    expect(isAdministrator(undefined)).toBe(false);
  });
});

describe('dayWord', () => {
  const now = new Date(2026, 9, 17, 15, 0);
  it('says today, yesterday, or the weekday', () => {
    expect(dayWord(new Date(2026, 9, 17, 1, 0), now)).toBe('today');
    expect(dayWord(new Date(2026, 9, 16, 23, 0), now)).toBe('yesterday');
    expect(dayWord(new Date(2026, 9, 12, 12, 0), now)).toBe('Monday');
    expect(dayWord(new Date(2026, 9, 11, 12, 0), now)).toBe('Sunday');
  });
  it('gives a short date once it is past the last six days, so an old day is never mistaken for this week', () => {
    expect(dayWord(new Date(2026, 9, 10, 12, 0), now)).toBe('10 Oct');
    expect(dayWord(new Date(2026, 9, 3, 12, 0), now)).toBe('3 Oct');
    expect(dayWord(new Date(2025, 11, 25, 12, 0), now)).toBe('25 Dec 2025');
  });
});

describe('rolePickableWorlds', () => {
  const all = ['hq', 'campus', 'lab'];
  it('lets "All worlds" widen someone limited to some worlds only for whoever gives roles everywhere and may add people everywhere', () => {
    expect(rolePickableWorlds(all, ['hq'], 'all', true)).toEqual({ all: true, ids: ['hq'] });
    expect(rolePickableWorlds(all, ['hq'], 'all', false)).toEqual({ all: false, ids: ['hq'] });
    expect(rolePickableWorlds(all, ['hq'], ['hq'], true)).toEqual({ all: false, ids: ['hq'] });
  });
  it('needs nothing extra when they are in every world already', () => {
    expect(rolePickableWorlds(all, 'all', 'all', false)).toEqual({ all: true, ids: all });
    expect(rolePickableWorlds(all, 'all', ['hq', 'lab'], true)).toEqual({ all: false, ids: ['hq', 'lab'] });
  });
  it('still lists only the worlds they are in that you may give roles in', () => {
    expect(rolePickableWorlds(all, ['hq', 'campus'], ['campus', 'lab'], true).ids).toEqual(['campus']);
  });
});
