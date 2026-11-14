// Builds a throwaway Postgres (PGlite) from every migration before "a Brick keeps what its template needs" (game #2008), saves a
// template with a need, two Bricks made from it (one on an older version) and one whose template is already gone, runs that
// migration, and prints what each Brick holds afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261114200000_brick_template_use_needs';

const db = new PGlite();
const names = fs.readdirSync(MIGRATIONS).filter((name) => /^\d/.test(name)).sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

const gmail = JSON.stringify([{ key: 'gmail', label: 'Gmail', kind: 'app', required: true }]);
const calendar = JSON.stringify([{ key: 'calendar', label: 'Calendar', kind: 'app', required: false }]);
await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('sara', 'uuid-sara', now()), ('omar', 'uuid-omar', now());
  INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('source', 'sara', 'Recipe Brick', now()), ('made1', 'omar', 'One', now()), ('made2', 'omar', 'Two', now()), ('made3', 'omar', 'Three', now());
  INSERT INTO brick_templates (id, bot_id, maker_id, current_version, updated_at) VALUES ('t1', 'source', 'sara', 2, now());
  INSERT INTO brick_template_versions (template_id, number, name, needs, content_hash) VALUES ('t1', 1, 'Recipe Brick', '${gmail}', 'a'), ('t1', 2, 'Recipe Brick', '${calendar}', 'b');
  INSERT INTO brick_template_uses (bot_id, template_id, version_number, maker_id, maker_name, template_name) VALUES
    ('made1', 't1', 2, 'sara', 'Sara', 'Recipe Brick'),
    ('made2', 't1', 1, 'sara', 'Sara', 'Recipe Brick'),
    ('made3', NULL, 1, NULL, 'Lina', 'Gone');
`);
const uses = async () => (await db.query('SELECT bot_id, template_id, version_number, maker_name, template_name FROM brick_template_uses ORDER BY bot_id')).rows;
const before = await uses();
await run(TARGET);
const after = await uses();
const needs = Object.fromEntries((await db.query('SELECT bot_id, needs FROM brick_template_uses ORDER BY bot_id')).rows.map((row) => [row.bot_id, row.needs]));
await db.exec(`INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('made4', 'omar', 'Four', now())`);
await db.exec(`INSERT INTO brick_template_uses (bot_id, template_id, version_number, maker_id, maker_name, template_name) VALUES ('made4', 't1', 2, 'sara', 'Sara', 'Recipe Brick')`);
const fresh = (await db.query(`SELECT needs FROM brick_template_uses WHERE bot_id = 'made4'`)).rows[0].needs;
// The template going for good no longer takes the needs with it
await db.exec(`DELETE FROM bots WHERE id = 'source'`);
const afterSourceGone = Object.fromEntries((await db.query('SELECT bot_id, template_id, needs FROM brick_template_uses ORDER BY bot_id')).rows.map((row) => [row.bot_id, { templateId: row.template_id, needs: row.needs }]));
console.log(JSON.stringify({ before, after, needs, fresh, afterSourceGone, gmail: JSON.parse(gmail), calendar: JSON.parse(calendar) }));
await db.close();
