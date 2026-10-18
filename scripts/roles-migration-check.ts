/**
 * Roles (#314) migration check. Run it on a COPY of production, never on production itself:
 *
 *   DATABASE_URL=postgres://...copy... ROLES_CHECK_ON_A_COPY=yes npx tsx scripts/roles-migration-check.ts
 *
 * Or rebuild production's shape first, from the counts scripts/roles-shape.sql printed on production (read-only), into
 * an empty local database at the schema before the roles migration:
 *
 *   DATABASE_URL=postgres://localhost/empty ROLES_CHECK_ON_A_COPY=yes npx tsx scripts/roles-migration-check.ts --from roles-shape.json
 *
 * The rebuild makes one user per person, the universes, worlds and rooms in the same order, every world member row with
 * its tags exactly as counted (duplicates and empty lists included) and every invitation with its status and tags, then
 * stops unless the database holds exactly the counted rows.
 *
 * It refuses any database that is not on this machine (localhost, 127.0.0.1, ::1 or a local socket), whatever the flag says:
 * production's data is never copied here, it is rebuilt from counts (see the roles check page).
 *
 * It records every world member before, applies prisma/migrations/20261017180000_roles to the copy, and compares:
 * - who is in which world (so who can enter which room: room entry only reads world membership),
 * - tags, where the only change allowed is `member` added (everyone who joined is a Member, decided 17 Oct),
 * - map editor access (today: an admin or editor tag; now: the Edit maps permission of their roles),
 * - the permission number the game gets, against what today's tags give it (admin 16383, editor 8416),
 * - that lib/roles.ts writes the same tags the migration wrote,
 * - that every invitation keeps its status and tags; a pending one carries exactly the roles its tags stand for, an
 *   accepted, rejected or cancelled one no role its tags don't (only pending ones are read; re-sending one starts
 *   again from its tags).
 * It prints the differences and exits 1 when any check fails. The copy is left migrated; the migration is not recorded
 * in _prisma_migrations, so throw the copy away afterwards.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { canSeeRoom } from '@/lib/room-visibility';
import { has, parsePermissions } from '@/lib/permissions';
import { ADMIN_KEY, EDITOR_KEY, MEMBER_KEY, permissionsFromTags, permissionsInWorld, tagsByWorld } from '@/lib/roles';

const MIGRATION = path.join(__dirname, '../prisma/migrations/20261017180000_roles/migration.sql');

interface Row {
  user_id: string;
  world_id: string;
  tags: string[];
}

/** Whether a database URL is on this machine: localhost, 127.0.0.1, ::1 or a local socket. */
function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return false;
  // A socket path in ?host= is local only when it is a path; a host name there could be anywhere
  const socket = parsed.searchParams.get('host');
  if (socket !== null && !socket.startsWith('/')) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const local = (name: string) => name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.startsWith('/');
  // No host in the URL means the driver falls back to PGHOST
  if (host === '') return socket !== null || !process.env.PGHOST || local(process.env.PGHOST);
  return local(host);
}

/** What scripts/roles-shape.sql prints: production's shape as counts, with no ids, names or tag text. */
interface Shape {
  complete: boolean;
  totals: { universes: number; worlds: number; rooms: number; world_members: number; invitations: number; invitations_by_status: Record<string, number> };
  universes: { u: number; public: boolean; worlds: { w: number; public: boolean; public_rooms: number; private_rooms: number }[] }[];
  people: { u: number; owner: boolean; count: number; worlds: { w: number; tags: string[] }[] }[];
  invitations: { u: number; w: number; status: string; tags: string[]; count: number }[];
}

/** Rebuilds a shape in an empty database, then proves the database holds exactly the counted rows. */
async function rebuild(pool: Pool, shape: Shape) {
  if (!shape.complete) throw new Error('The shape file says complete: false, so rows are missing from it. Nothing was rebuilt.');
  const [{ n }] = (await pool.query('SELECT (SELECT count(*) FROM universes) + (SELECT count(*) FROM users) AS n')).rows;
  if (Number(n) !== 0) throw new Error('Rebuild needs an empty database: it has universes or users.');
  const client = await pool.connect();
  const insert = (sql: string, values: unknown[]) => client.query(sql, values);
  try {
    await client.query('BEGIN');
    const newUser = async () => {
      const id = randomUUID();
      await insert('INSERT INTO users (id, uuid, updated_at) VALUES ($1, $2, now())', [id, `shape-${id}`]);
      return id;
    };
    const worlds = new Map<string, string>();
    const owners = new Map<number, string>();
    for (const universe of shape.universes) {
      const id = randomUUID();
      const owner = await newUser();
      owners.set(universe.u, owner);
      // created_at keeps the order the shape numbered them in
      await insert(
        `INSERT INTO universes (id, slug, name, owner_id, is_public, created_at, updated_at)
         VALUES ($1, $2, $2, $3, $4, timestamp '2026-01-01' + make_interval(mins => $5), now())`,
        [id, `u${universe.u}`, owner, universe.public, universe.u],
      );
      for (const world of universe.worlds) {
        const worldId = randomUUID();
        worlds.set(`${universe.u} ${world.w}`, worldId);
        await insert(
          `INSERT INTO worlds (id, universe_id, slug, name, is_public, created_at, updated_at)
           VALUES ($1, $2, $3, $3, $4, timestamp '2026-01-01' + make_interval(mins => $5), now())`,
          [worldId, id, `w${world.w}`, world.public, world.w],
        );
        for (let k = 0; k < world.public_rooms + world.private_rooms; k += 1) {
          await insert('INSERT INTO rooms (id, world_id, slug, name, is_public, updated_at) VALUES ($1, $2, $3, $3, $4, now())', [
            randomUUID(),
            worldId,
            `r${k}`,
            k < world.public_rooms,
          ]);
        }
      }
    }
    const world = (u: number, w: number) => {
      const id = worlds.get(`${u} ${w}`);
      if (!id) throw new Error(`The shape names world ${w} of universe ${u}, which it does not list`);
      return id;
    };
    for (const person of shape.people) {
      for (let k = 0; k < person.count; k += 1) {
        const userId = person.owner ? owners.get(person.u)! : await newUser();
        for (const row of person.worlds) {
          await insert('INSERT INTO world_members (id, user_id, world_id, tags) VALUES ($1, $2, $3, $4)', [randomUUID(), userId, world(person.u, row.w), row.tags]);
        }
      }
    }
    for (const invitation of shape.invitations) {
      for (let k = 0; k < invitation.count; k += 1) {
        await insert(
          'INSERT INTO membership_invitations (id, world_id, invited_user_id, invited_by_user_id, status, tags) VALUES ($1, $2, $3, $4, $5, $6)',
          [randomUUID(), world(invitation.u, invitation.w), await newUser(), owners.get(invitation.u), invitation.status, invitation.tags],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Exactly the counted rows, not about: every total and the invitations of each status
  const counts = (
    await pool.query(`SELECT (SELECT count(*) FROM universes)::int AS universes, (SELECT count(*) FROM worlds)::int AS worlds,
      (SELECT count(*) FROM rooms)::int AS rooms, (SELECT count(*) FROM world_members)::int AS world_members,
      (SELECT count(*) FROM membership_invitations)::int AS invitations,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*)::int AS n FROM membership_invitations GROUP BY status) s) AS invitations_by_status`)
  ).rows[0];
  const wanted = shape.totals;
  const same =
    (['universes', 'worlds', 'rooms', 'world_members', 'invitations'] as const).every((key) => counts[key] === Number(wanted[key])) &&
    JSON.stringify(Object.entries(counts.invitations_by_status).sort()) ===
      JSON.stringify(Object.entries(wanted.invitations_by_status).map(([status, n]) => [status, Number(n)]).sort());
  console.log(`Rebuilt from the shape: ${JSON.stringify(counts)}`);
  if (!same) throw new Error(`The rebuild does not match the shape's totals: ${JSON.stringify(wanted)}`);
  console.log('Rebuild matches the shape exactly.');
}

const keyOf = (row: { user_id: string; world_id: string }) => `${row.user_id} ${row.world_id}`;

async function main() {
  if (process.env.ROLES_CHECK_ON_A_COPY !== 'yes') {
    console.error('This changes the database it runs on. Run it on a copy of production with ROLES_CHECK_ON_A_COPY=yes.');
    process.exit(2);
  }
  if (!isLocalDatabase(process.env.DATABASE_URL)) {
    console.error('Refusing: DATABASE_URL is not a database on this machine. This check only runs on a local throwaway copy.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = async <T>(sql: string): Promise<T[]> => (await pool.query(sql)).rows as T[];

  const already = await q<{ exists: boolean }>("SELECT to_regclass('public.roles') IS NOT NULL AS exists");
  if (already[0].exists) {
    console.error('The roles migration is already applied here: use a copy taken before it.');
    process.exit(2);
  }
  const from = process.argv.indexOf('--from');
  if (from !== -1) await rebuild(pool, JSON.parse(fs.readFileSync(process.argv[from + 1], 'utf8')) as Shape);

  const before = await q<Row>('SELECT user_id, world_id, tags FROM world_members');
  const invitationsBefore = await q<{ id: string; status: string; tags: string[] }>(
    'SELECT id, status, tags FROM membership_invitations',
  );
  const rooms = await q<{
    id: string;
    is_public: boolean;
    world_id: string;
    world_public: boolean;
    universe_public: boolean;
    owner_id: string;
  }>(`SELECT r.id, r.is_public, w.id AS world_id, w.is_public AS world_public, u.is_public AS universe_public, u.owner_id
      FROM rooms r JOIN worlds w ON w.id = r.world_id JOIN universes u ON u.id = w.universe_id`);

  await pool.query(fs.readFileSync(MIGRATION, 'utf8'));

  const after = await q<Row>('SELECT user_id, world_id, tags FROM world_members');
  const worlds = await q<{ id: string; universe_id: string }>('SELECT id, universe_id FROM worlds ORDER BY created_at');
  const roles = await q<{ id: string; universe_id: string; key: string; position: number; permissions: string }>(
    'SELECT id, universe_id, key, position, permissions::text AS permissions FROM roles',
  );
  const members = await q<{ id: string; universe_id: string; user_id: string; all_worlds: boolean; world_ids: string[] }>(
    'SELECT id, universe_id, user_id, all_worlds, world_ids FROM universe_members',
  );
  const given = await q<{ member_id: string; role_id: string; all_worlds: boolean; world_ids: string[] }>(
    'SELECT member_id, role_id, all_worlds, world_ids FROM universe_member_roles',
  );
  const invitationsAfter = await q<{ id: string; status: string; tags: string[]; role_ids: string[] }>(
    'SELECT id, status, tags, role_ids FROM membership_invitations',
  );

  const failures: string[] = [];
  const memberAdded: string[] = [];
  const fail = (line: string) => failures.push(line);

  // 1. Same people in the same worlds, so the same room entry
  const beforeByKey = new Map(before.map((row) => [keyOf(row), row]));
  const afterByKey = new Map(after.map((row) => [keyOf(row), row]));
  for (const key of beforeByKey.keys()) if (!afterByKey.has(key)) fail(`lost world membership: ${key}`);
  for (const key of afterByKey.keys()) if (!beforeByKey.has(key)) fail(`gained world membership: ${key}`);

  let roomChecks = 0;
  const usersBefore = new Map<string, Set<string>>();
  const usersAfter = new Map<string, Set<string>>();
  for (const row of before) usersBefore.set(row.user_id, (usersBefore.get(row.user_id) ?? new Set()).add(row.world_id));
  for (const row of after) usersAfter.set(row.user_id, (usersAfter.get(row.user_id) ?? new Set()).add(row.world_id));
  for (const userId of new Set([...usersBefore.keys(), ...usersAfter.keys()])) {
    for (const room of rooms) {
      const record = {
        isPublic: room.is_public,
        world: { id: room.world_id, isPublic: room.world_public, universe: { isPublic: room.universe_public, ownerId: room.owner_id } },
      };
      const viewer = { id: userId, isSuperAdmin: false };
      const was = canSeeRoom(record, viewer, usersBefore.get(userId) ?? new Set());
      const now = canSeeRoom(record, viewer, usersAfter.get(userId) ?? new Set());
      roomChecks += 1;
      if (was !== now) fail(`room entry changed: user ${userId} room ${room.id} ${was} -> ${now}`);
    }
  }

  // 2. Tags: only `member` may be added
  for (const [key, row] of beforeByKey) {
    const next = afterByKey.get(key);
    if (!next) continue;
    const was = new Set(row.tags);
    const now = new Set(next.tags);
    const lost = [...was].filter((tag) => !now.has(tag));
    const gained = [...now].filter((tag) => !was.has(tag));
    if (lost.length) fail(`tags lost: ${key} [${row.tags}] -> [${next.tags}]`);
    if (gained.some((tag) => tag !== MEMBER_KEY)) fail(`tags gained: ${key} [${row.tags}] -> [${next.tags}]`);
    if (gained.includes(MEMBER_KEY)) memberAdded.push(`${key} [${row.tags}] -> [${next.tags}]`);
  }

  // 3-5. Map editor access, the game's permission number, and lib/roles.ts agreeing with the migration
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const rolesOf = new Map<string, typeof given>();
  for (const row of given) rolesOf.set(row.member_id, [...(rolesOf.get(row.member_id) ?? []), row]);
  const worldIdsOf = new Map<string, string[]>();
  for (const world of worlds) worldIdsOf.set(world.universe_id, [...(worldIdsOf.get(world.universe_id) ?? []), world.id]);
  const universeOfWorld = new Map(worlds.map((world) => [world.id, world.universe_id]));

  for (const member of members) {
    const scoped = (rolesOf.get(member.id) ?? []).map((row) => {
      const role = roleById.get(row.role_id)!;
      return {
        key: role.key,
        position: role.position,
        permissions: parsePermissions(role.permissions) ?? BigInt(0),
        allWorlds: row.all_worlds,
        worldIds: row.world_ids,
      };
    });
    const scope = { allWorlds: member.all_worlds, worldIds: member.world_ids };
    const wanted = tagsByWorld(scope, scoped, worldIdsOf.get(member.universe_id) ?? []);
    for (const [worldId, tags] of wanted) {
      const key = `${member.user_id} ${worldId}`;
      const written = afterByKey.get(key);
      if (!written) {
        fail(`lib/roles.ts would add ${key}, the migration did not`);
        continue;
      }
      if (written.tags.length !== tags.length || !tags.every((tag) => written.tags.includes(tag))) {
        fail(`lib/roles.ts would write [${tags}] for ${key}, the migration wrote [${written.tags}]`);
      }
      const old = beforeByKey.get(key)?.tags ?? [];
      const everyone = roles.find((role) => role.universe_id === member.universe_id && role.key === 'everyone');
      const memberRole = roles.find((role) => role.universe_id === member.universe_id && role.key === MEMBER_KEY);
      const permissions = permissionsInWorld(
        worldId,
        parsePermissions(everyone?.permissions ?? '0') ?? BigInt(0),
        { scope, member: parsePermissions(memberRole?.permissions ?? '0') ?? BigInt(0), inWorld: true },
        scoped,
      );
      const canEditBefore = old.includes(EDITOR_KEY) || old.includes(ADMIN_KEY);
      if (has(permissions, 'EDIT_MAPS') !== canEditBefore) fail(`map editor access changed: ${key}`);
      if (permissions !== permissionsFromTags(old)) {
        fail(`game permissions changed: ${key} ${permissionsFromTags(old)} -> ${permissions}`);
      }
    }
    for (const row of after) {
      if (row.user_id === member.user_id && universeOfWorld.get(row.world_id) === member.universe_id && !wanted.has(row.world_id)) {
        fail(`lib/roles.ts would remove ${row.user_id} ${row.world_id}, the migration kept it`);
      }
    }
  }

  // 6. The migration rewrites every invitation, not only the pending ones. Each keeps its status and tags. A pending one
  // gives the same tags (plus member) through its roles. Nothing reads the roles of an accepted, rejected or cancelled
  // one (accepting needs pending, re-sending clears them and starts from the tags), and a tag nobody holds any more makes
  // no role, so those may carry fewer roles than tags but never one their tags don't name.
  const invitationsById = new Map(invitationsAfter.map((row) => [row.id, row]));
  for (const invitation of invitationsBefore) {
    const now = invitationsById.get(invitation.id);
    if (!now) {
      fail(`invitation ${invitation.id} lost`);
      continue;
    }
    if (now.status !== invitation.status) fail(`invitation ${invitation.id} status ${invitation.status} -> ${now.status}`);
    if (now.tags.join('\n') !== invitation.tags.join('\n')) fail(`invitation ${invitation.id} tags [${invitation.tags}] -> [${now.tags}]`);
    const keys = new Set(now.role_ids.map((id) => roleById.get(id)?.key));
    keys.add(MEMBER_KEY);
    const wanted = new Set([...invitation.tags, MEMBER_KEY].filter((tag) => tag !== 'everyone'));
    const extra = [...keys].some((key) => key === undefined || !wanted.has(key));
    const missing = invitation.status === 'pending' && [...wanted].some((tag) => !keys.has(tag));
    if (extra || missing) {
      fail(`invitation ${invitation.id} changed: [${invitation.tags}] -> [${[...keys]}]`);
    }
  }

  console.log(`World member rows: ${before.length} before, ${after.length} after`);
  console.log(`Room entry checks: ${roomChecks}`);
  console.log(`Universes: ${new Set(worlds.map((world) => world.universe_id)).size}, people: ${members.length}, roles given: ${given.length}`);
  console.log(`Custom roles from typed tags: ${roles.filter((role) => !['admin', 'editor', 'member', 'everyone'].includes(role.key)).map((role) => role.key).join(', ') || 'none'}`);
  const byStatus = new Map<string, number>();
  for (const invitation of invitationsBefore) byStatus.set(invitation.status, (byStatus.get(invitation.status) ?? 0) + 1);
  console.log(`Invitations: ${invitationsBefore.length} (${[...byStatus].map(([status, n]) => `${status} ${n}`).join(', ') || 'none'})`);
  console.log(`Rows that gained only the member tag (expected, everyone who joined is a Member): ${memberAdded.length}`);
  for (const line of memberAdded) console.log(`  ${line}`);
  let head = 'unknown';
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    head = git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--', 'scripts', 'prisma', 'lib') ? ' with local changes' : '');
  } catch {
    // not a git checkout
  }
  console.log(`Migration and check at commit ${head}`);
  if (failures.length > 0) {
    console.log(`\nDIFFERENCES: ${failures.length}`);
    for (const line of failures) console.log(`  ${line}`);
  } else {
    console.log('\nDIFFERENCES: 0');
  }
  await pool.end();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
