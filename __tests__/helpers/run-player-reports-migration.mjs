// Builds a throwaway Postgres (PGlite) from every migration before the player-reports one, adds one ban of each old
// kind, runs the player-reports migration and prints what the bans look like afterwards as JSON.
// It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261004101856_player_reports';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
for (const name of names.slice(0, names.indexOf(TARGET))) {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
}

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('u1', 'uuid-1', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('uni1', 'acme', 'Acme', 'u1', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'uni1', 'office', 'Office', now());

  -- A: made in the game, so it carries the world and its universe
  INSERT INTO bans (id, user_id, world_id, universe_id, is_active) VALUES ('A-active', 'u1', 'w1', 'uni1', true);
  INSERT INTO bans (id, user_id, world_id, universe_id, is_active) VALUES ('A-lifted', 'u1', 'w1', 'uni1', false);
  -- B: its world was deleted, so only the universe is left
  INSERT INTO bans (id, user_id, world_id, universe_id, is_active) VALUES ('B-active', 'u1', NULL, 'uni1', true);
  INSERT INTO bans (id, user_id, world_id, universe_id, is_active) VALUES ('B-lifted', 'u1', NULL, 'uni1', false);
  -- C: from one world
  INSERT INTO bans (id, user_id, world_id, universe_id, is_active) VALUES ('C-active', 'u1', 'w1', NULL, true);
  -- D: everywhere
  INSERT INTO bans (id, user_id, world_id, universe_id, is_active) VALUES ('D-active', 'u1', NULL, NULL, true);
  INSERT INTO bans (id, ip_address, world_id, universe_id, is_active) VALUES ('D-address', '10.0.0.1', NULL, NULL, true);
`);

await db.exec(fs.readFileSync(path.join(MIGRATIONS, TARGET, 'migration.sql'), 'utf8'));

const result = await db.query(
  'SELECT id, world_id, universe_id, is_active, appealed_at, appeal_text, lifted_at, lifted_by FROM bans ORDER BY id',
);
console.log(JSON.stringify(result.rows));
await db.close();
