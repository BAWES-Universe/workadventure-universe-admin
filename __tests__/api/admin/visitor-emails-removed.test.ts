/**
 * The old `GET /api/admin/worlds/[id]/visitors` returned the email of every signed-in visitor to a universe owner or world
 * Admin, while the Visitors list deliberately keeps emails from managers. Nothing used it, so it was deleted. These checks
 * keep it (and anything shaped like it) from coming back.
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

describe('visitor emails stay with super admins', () => {
  it('has no world visitors route, so the old address answers 404', () => {
    expect(fs.existsSync(path.join(root, 'app/api/admin/worlds/[id]/visitors/route.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'app/api/admin/worlds/[id]/visitors'))).toBe(false);
  });

  it('has no dialog left that read it', () => {
    expect(fs.existsSync(path.join(root, 'app/admin/components/invite-member-dialog.tsx'))).toBe(false);
  });

  it('reads a visit’s stored email only in the routes that decide who may see it', () => {
    // Routes that select RoomAccess.userEmail: each one hides it from anyone who is not allowed to see emails.
    const allowed = new Set([
      'app/api/room/access/route.ts', // writes the visit
      'app/api/admin/analytics/rooms/[id]/route.ts',
      'app/api/admin/analytics/universes/[id]/route.ts',
      'app/api/admin/analytics/worlds/[id]/route.ts',
    ]);
    const readers = routeFiles(path.join(root, 'app/api'))
      .map((file) => path.relative(root, file))
      .filter((file) => fs.readFileSync(path.join(root, file), 'utf8').includes('userEmail: true'))
      .filter((file) => !allowed.has(file));
    expect(readers).toEqual([]);
  });
});
