/**
 * The exact list of migrations Orbit 0.5.0 ships (prisma/migration-manifest.json, docs/RELEASE-0.5.0-MIGRATIONS.md), checked against the directory, and the
 * superseded key-form migration (GPT money review O6) is nowhere in the shipping tree. No database needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'prisma/migration-manifest.json'), 'utf8')) as {
  baseline: { tag: string; migrations: string[]; checksums: Record<string, string> };
  superseded: Array<{ name: string; standaloneCommit: string; replacedBy: string[] }>;
  shipping: { lastMigration: string; count: number; migrations: string[] };
};
const directory = fs
  .readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const check = () => spawnSync(process.execPath, [path.join(root, 'scripts/migration-manifest.mjs')], { encoding: 'utf8' });

describe('the migrations 0.5.0 ships', () => {
  it('the manifest, the directory and the published list say the same thing (the script that writes it finds nothing to change)', () => {
    const result = check();
    expect({ status: result.status, out: result.stderr || result.stdout }).toEqual({ status: 0, out: expect.stringContaining(`${manifest.shipping.count} migrations`) });
    expect(manifest.shipping.migrations).toEqual(directory.filter((name) => name <= manifest.shipping.lastMigration));
  });

  it('the list in the docs page is the same list, one line per migration, in order', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/RELEASE-0.5.0-MIGRATIONS.md'), 'utf8');
    const region = doc.slice(doc.indexOf('<!-- migrations:start -->'), doc.indexOf('<!-- migrations:end -->'));
    const listed = [...region.matchAll(/^\s*\d+\. `([^`]+)`$/gm)].map((match) => match[1]);
    expect(listed).toEqual(manifest.shipping.migrations);
  });

  it('production’s 77 migrations (tag v0.3.44) are all still shipped, unchanged, and everything else is new', () => {
    expect(manifest.baseline.tag).toBe('v0.3.44');
    expect(manifest.baseline.migrations).toHaveLength(77);
    for (const name of manifest.baseline.migrations) expect(manifest.shipping.migrations).toContain(name);
    expect(manifest.shipping.count - manifest.baseline.migrations.length).toBe(manifest.shipping.migrations.filter((name) => !manifest.baseline.migrations.includes(name)).length);
    expect(Object.keys(manifest.baseline.checksums).sort()).toEqual([...manifest.baseline.migrations].sort());
  });

  it('a migration production already ran that is edited is caught (Prisma would refuse to deploy over it)', () => {
    const file = path.join(root, 'prisma/migrations', manifest.baseline.migrations[0], 'migration.sql');
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, '\n-- edited\n');
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`edited after production ran it`);
      expect(result.stderr).toContain(manifest.baseline.migrations[0]);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it('a migration directory that is not in the manifest, and one in the manifest that is missing, are both caught', () => {
    const extra = path.join(root, 'prisma/migrations', '20261119135001_not_in_the_manifest');
    fs.mkdirSync(extra);
    try {
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('in prisma/migrations but not in the manifest: 20261119135001_not_in_the_manifest');
    } finally {
      fs.rmSync(extra, { recursive: true });
    }
    const last = path.join(root, 'prisma/migrations', manifest.shipping.lastMigration);
    const moved = `${last}.moved`;
    fs.renameSync(last, moved);
    try {
      expect(check().stderr).toContain(`in the manifest but not in prisma/migrations: ${manifest.shipping.lastMigration}`);
    } finally {
      fs.renameSync(moved, last);
    }
  });
});

describe('the key-form holds migration is superseded', () => {
  const old = manifest.superseded.find((one) => one.name === '20261119135000_app_key_holds');

  it('is marked superseded, names what replaced it, and the replacement ships', () => {
    expect(old).toMatchObject({ standaloneCommit: '13cec427' });
    for (const name of old?.replacedBy ?? []) expect(manifest.shipping.migrations).toContain(name);
    expect(old?.replacedBy).toContain('20261119100000_app_key_request_reservation_epoch');
  });

  it('is not in the directory or the shipping list, and no migration creates the table', () => {
    expect(directory).not.toContain('20261119135000_app_key_holds');
    expect(manifest.shipping.migrations).not.toContain('20261119135000_app_key_holds');
    for (const name of manifest.shipping.migrations) expect(fs.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')).not.toMatch(/app_key_holds/);
  });

  it('is not in the schema or in any code: nothing reads or writes the table', () => {
    expect(fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8')).not.toMatch(/app_key_holds|AppKeyHold/);
    const found = spawnSync('grep', ['-rlE', 'app_key_holds|appKeyHold|AppKeyHold', 'lib', 'app', 'components', '--include=*.ts', '--include=*.tsx'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    expect(found).toBe('');
  });
});
