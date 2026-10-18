/**
 * A face's highest role is found by its tag exactly as the role's key is stored: keys from tags typed before roles keep
 * their capitals (VIP), and the tags on world rows are written from those keys.
 */
import { topUniverseRole } from '@/app/admin/components/members-row';
import type { UniverseRole } from '@/app/admin/components/universe-people';

const role = (key: string, position: number) => ({ id: key, key, name: key, color: '#fff', position, people: 0 }) as unknown as UniverseRole;
const byKey = new Map([role('admin', 1000000), role('VIP', 12), role('member', 1)].map((r) => [r.key, r]));

describe('topUniverseRole', () => {
  it('finds a role whose key has capitals', () => {
    expect(topUniverseRole({ tags: ['VIP', 'member'] }, byKey)?.key).toBe('VIP');
  });

  it('picks the highest of their roles', () => {
    expect(topUniverseRole({ tags: ['member', 'VIP', 'admin'] }, byKey)?.key).toBe('admin');
  });

  it('is null when no tag is a role of the universe', () => {
    expect(topUniverseRole({ tags: ['ghost'] }, byKey)).toBeNull();
  });
});
