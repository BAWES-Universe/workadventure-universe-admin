// Builds a throwaway Postgres (PGlite) from every migration before "Brick templates" (game #2008), saves a room bot and
// Bricks the way Orbit has them today, runs that migration, and prints what it left alone and what the new tables accept
// and do from then on. Its own process because PGlite loads itself with dynamic imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261114180000_brick_templates';

const db = new PGlite();
const names = fs.readdirSync(MIGRATIONS).filter((name) => /^\d/.test(name)).sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now()), ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now()), ('lina', 'uuid-lina', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
  INSERT INTO bots (id, room_id, name, created_by_id, updated_at) VALUES ('bot1', 'room1', 'Nora', 'owner', '2026-01-02 03:04:05');
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick1', 'sara', 'Recipe Brick', now()), ('brick2', 'omar', 'Brick', now()), ('brick3', 'lina', 'Brick', now());
`);
const everything = async () => ({ users: (await db.query('SELECT * FROM users ORDER BY id')).rows, bots: (await db.query('SELECT * FROM bots ORDER BY id')).rows, rooms: (await db.query('SELECT * FROM rooms ORDER BY id')).rows });
const before = await everything();
await run(TARGET);
const after = await everything();
const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const rowsAfterMigration = { templates: await count('brick_templates'), versions: await count('brick_template_versions'), uses: await count('brick_template_uses'), stars: await count('brick_template_stars') };
const accepted = async (sql) => { try { await db.exec(sql); return true; } catch { return false; } };
const columnsOf = async (table) => (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY column_name`)).rows.map((row) => row.column_name);
const columns = { templates: await columnsOf('brick_templates'), versions: await columnsOf('brick_template_versions'), uses: await columnsOf('brick_template_uses'), stars: await columnsOf('brick_template_stars') };

await db.exec(`INSERT INTO brick_templates (id, bot_id, maker_id, updated_at) VALUES ('t1', 'brick1', 'sara', now())`);
await db.exec(`INSERT INTO brick_template_versions (template_id, number, name, content_hash) VALUES ('t1', 1, 'Recipe Brick', 'abc')`);
const defaults = (await db.query(`SELECT audience, current_version, choices, stopped_at, picked_at FROM brick_templates WHERE id = 't1'`)).rows[0];
const versionDefaults = (await db.query(`SELECT needs, routines FROM brick_template_versions WHERE template_id = 't1'`)).rows[0];
const checks = {
  secondTemplateForTheSameBrick: await accepted(`INSERT INTO brick_templates (id, bot_id, maker_id, updated_at) VALUES ('t2', 'brick1', 'sara', now())`),
  noBrick: await accepted(`INSERT INTO brick_templates (id, bot_id, maker_id, updated_at) VALUES ('t3', 'nothing', 'sara', now())`),
  noMaker: await accepted(`INSERT INTO brick_templates (id, bot_id, maker_id, updated_at) VALUES ('t4', 'brick2', 'nobody', now())`),
  audienceNeitherEveryoneNorLink: await accepted(`INSERT INTO brick_templates (id, bot_id, maker_id, audience, updated_at) VALUES ('t5', 'brick2', 'omar', 'team', now())`),
  audienceLink: await accepted(`INSERT INTO brick_templates (id, bot_id, maker_id, audience, updated_at) VALUES ('t6', 'brick2', 'omar', 'link', now())`),
  sameVersionNumberTwice: await accepted(`INSERT INTO brick_template_versions (template_id, number, name, content_hash) VALUES ('t1', 1, 'Again', 'def')`),
  nextVersionNumber: await accepted(`INSERT INTO brick_template_versions (template_id, number, name, content_hash) VALUES ('t1', 2, 'Recipe Brick', 'def')`),
  versionOfNoTemplate: await accepted(`INSERT INTO brick_template_versions (template_id, number, name, content_hash) VALUES ('nothing', 1, 'x', 'x')`),
  starTwice: await accepted(`INSERT INTO brick_template_stars (user_id, template_id) VALUES ('lina', 't1'), ('lina', 't1')`),
  starOnce: await accepted(`INSERT INTO brick_template_stars (user_id, template_id) VALUES ('lina', 't1')`),
  useOfNoBrick: await accepted(`INSERT INTO brick_template_uses (bot_id, template_id, version_number, maker_id, maker_name, template_name) VALUES ('nothing', 't1', 1, 'sara', 'Sara', 'x')`),
  useTwiceForOneBrick: await accepted(`INSERT INTO brick_template_uses (bot_id, template_id, version_number, maker_id, maker_name, template_name) VALUES ('brick3', 't1', 1, 'sara', 'Sara', 'Recipe Brick'), ('brick3', 't1', 2, 'sara', 'Sara', 'Recipe Brick')`),
  useOnce: await accepted(`INSERT INTO brick_template_uses (bot_id, template_id, version_number, maker_id, maker_name, template_name) VALUES ('brick3', 't1', 1, 'sara', 'Sara', 'Recipe Brick')`),
};
const bricksWithARoom = await count(`bots WHERE owner_id IS NOT NULL AND room_id IS NOT NULL`);

// A template going for good (its Brick is removed) takes its versions and stars, and the Brick made from it keeps the line
await db.exec(`DELETE FROM bots WHERE id = 'brick1'`);
const afterSourceGone = {
  templates: await count(`brick_templates WHERE id = 't1'`),
  versions: await count(`brick_template_versions WHERE template_id = 't1'`),
  stars: await count('brick_template_stars'),
  useKept: await count(`brick_template_uses WHERE bot_id = 'brick3'`),
  useTemplateId: (await db.query(`SELECT template_id, maker_name, template_name FROM brick_template_uses WHERE bot_id = 'brick3'`)).rows[0],
  bricksLeft: await count(`bots WHERE owner_id IS NOT NULL`),
};

// The Brick made from a template going takes only its own use row
await db.exec(`DELETE FROM bots WHERE id = 'brick3'`);
const usesAfterMadeBrickGone = await count('brick_template_uses');

// A maker leaving takes their template, and the maker's name stays on what was made from it
await db.exec(`INSERT INTO brick_templates (id, bot_id, maker_id, updated_at) VALUES ('t7', 'brick2', 'omar', now()) ON CONFLICT DO NOTHING`);
await db.exec(`INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('brick4', 'lina', 'Brick', now())`);
await db.exec(`INSERT INTO brick_template_uses (bot_id, template_id, version_number, maker_id, maker_name, template_name) VALUES ('brick4', (SELECT id FROM brick_templates WHERE bot_id = 'brick2'), 1, 'omar', 'Omar', 'Brick')`);
await db.exec(`DELETE FROM users WHERE id = 'omar'`);
const afterMakerGone = {
  templates: await count(`brick_templates WHERE maker_id IS NOT NULL AND bot_id = 'brick2'`),
  use: (await db.query(`SELECT template_id, maker_id, maker_name FROM brick_template_uses WHERE bot_id = 'brick4'`)).rows[0],
};
// A person who starred it leaving takes only their star
await db.exec(`INSERT INTO brick_templates (id, bot_id, maker_id, updated_at) VALUES ('t8', 'brick4', 'lina', now())`);
await db.exec(`INSERT INTO brick_template_stars (user_id, template_id) VALUES ('sara', 't8')`);
await db.exec(`DELETE FROM users WHERE id = 'sara'`);
const starsAfterPersonGone = await count('brick_template_stars');

console.log(JSON.stringify({ before, after, rowsAfterMigration, columns, defaults, versionDefaults, checks, bricksWithARoom, afterSourceGone, usesAfterMadeBrickGone, afterMakerGone, starsAfterPersonGone }));
await db.close();
