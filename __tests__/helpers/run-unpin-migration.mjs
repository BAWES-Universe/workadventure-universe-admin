// Builds a throwaway Postgres (PGlite) from every migration before "unpin bots from providers" (game #1446), saves bots
// the ways their provider can be set today, runs that migration, and prints the bots and providers before and after as
// JSON. It runs as its own process because PGlite loads itself with dynamic imports, which Jest does not allow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const TARGET = '20261026110000_unpin_bots_from_providers';

const db = new PGlite();
const names = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d/.test(name))
  .sort();
const run = async (name) => db.exec(fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'));
for (const name of names.slice(0, names.indexOf(TARGET))) await run(name);

await db.exec(`
  INSERT INTO users (id, uuid, updated_at) VALUES ('owner', 'uuid-owner', now());
  INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('u1', 'acme', 'Acme', 'owner', now());
  INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'u1', 'hq', 'HQ', now());
  INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());

  -- Two of the server's own providers (no owner), the first the Default, and a person's key
  INSERT INTO bots_ai_providers (provider_id, name, type, enabled, is_default, updated_at) VALUES
    ('deepseek-flash', 'DeepSeek V4 Flash', 'openai', true, true, now()),
    ('claude-sonnet', 'Claude Sonnet', 'anthropic', true, false, now());
  INSERT INTO bots_ai_providers (provider_id, name, type, enabled, owner_id, updated_at) VALUES ('key-1', 'My OpenRouter', 'openai', true, 'owner', now());

  INSERT INTO bots (id, room_id, name, ai_provider_ref, ai_model, updated_at) VALUES
    ('pinned-default', 'room1', 'On the default', 'deepseek-flash', NULL, '2026-10-01 10:00:00'),
    ('pinned-other', 'room1', 'On Claude', 'claude-sonnet', 'stale-model', '2026-10-01 10:00:00'),
    ('universe-ai', 'room1', 'Universe AI', 'universe-ai', NULL, '2026-10-01 10:00:00'),
    ('on-key', 'room1', 'On a key', 'key-1', 'anthropic/claude-haiku-5-5', '2026-10-01 10:00:00'),
    ('no-ref', 'room1', 'No ref', NULL, NULL, '2026-10-01 10:00:00'),
    ('provider-gone', 'room1', 'Provider gone', 'deleted-provider', NULL, '2026-10-01 10:00:00'),
    ('key-gone', 'room1', 'Key gone', 'key-9', 'm', '2026-10-01 10:00:00');
`);
const bots = async () => (await db.query('SELECT id, ai_provider_ref, ai_model, updated_at > \'2026-10-02\' AS touched FROM bots ORDER BY id')).rows;
const providers = async () => (await db.query('SELECT provider_id, name, owner_id, is_default, enabled FROM bots_ai_providers ORDER BY provider_id')).rows;
const before = { bots: await bots(), providers: await providers() };
await run(TARGET);
const after = { bots: await bots(), providers: await providers() };
console.log(JSON.stringify({ before, after }));
await db.close();
