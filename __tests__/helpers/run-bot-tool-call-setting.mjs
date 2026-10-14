// PGlite's dynamic imports run outside Jest, as in the existing migration tests.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const queries = JSON.parse(fs.readFileSync(0, 'utf8'));
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE bots (id text PRIMARY KEY, behavior_config jsonb NOT NULL DEFAULT '{}', updated_at timestamptz, updated_by_id text);
    INSERT INTO bots VALUES ('bot-a', '{"moves":"route","waypoints":[{"x":32,"y":64}]}', NULL, NULL), ('bot-b', '{}', NULL, NULL)`);
  const snapshots = [];
  for (const query of queries) {
    await db.query(query.text, query.values);
    snapshots.push((await db.query('SELECT * FROM bots ORDER BY id')).rows);
  }
  console.log(JSON.stringify(snapshots));
} finally {
  await db.close();
}
