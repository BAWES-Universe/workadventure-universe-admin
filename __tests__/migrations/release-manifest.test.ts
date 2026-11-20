/**
 * The exact list of migrations Orbit 0.5.0 ships (prisma/migration-manifest.json, docs/RELEASE-0.5.0-MIGRATIONS.md), checked against the directory, and the
 * superseded key-form migration (GPT money review O6) is nowhere in the shipping tree. No database needed.
 */
import fs from 'node:fs';
import os from 'node:os';
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
  .filter((entry) => entry.isDirectory() && /^\d{8,14}_/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const check = (where: string = root, args: string[] = []) => spawnSync(process.execPath, [path.join(where, 'scripts/migration-manifest.mjs'), ...args], { encoding: 'utf8' });

/**
 * A private copy of what the script reads (the script itself, the manifest, the docs page and every migration directory), so a check that renames, edits or adds a
 * directory never touches the shared tree the other suites (the upgrade tests, which copy from it and deploy from it) read at the same time.
 */
const isolated = (): { dir: string; migrations: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-manifest-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'prisma'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.copyFileSync(path.join(root, 'scripts/migration-manifest.mjs'), path.join(dir, 'scripts/migration-manifest.mjs'));
  fs.copyFileSync(path.join(root, 'prisma/migration-manifest.json'), path.join(dir, 'prisma/migration-manifest.json'));
  fs.copyFileSync(path.join(root, 'docs/RELEASE-0.5.0-MIGRATIONS.md'), path.join(dir, 'docs/RELEASE-0.5.0-MIGRATIONS.md'));
  fs.cpSync(path.join(root, 'prisma/migrations'), path.join(dir, 'prisma/migrations'), { recursive: true });
  return { dir, migrations: path.join(dir, 'prisma/migrations') };
};

describe('the migrations 0.5.0 ships', () => {
  it('the manifest, the directory and the published list say the same thing (the script that writes it finds nothing to change)', () => {
    const result = check();
    expect({ status: result.status, out: result.stderr || result.stdout }).toEqual({ status: 0, out: expect.stringContaining(`${manifest.shipping.count} migrations`) });
    expect(manifest.shipping.migrations).toEqual(directory);
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
    const copy = isolated();
    try {
      const file = path.join(copy.migrations, manifest.baseline.migrations[0], 'migration.sql');
      fs.appendFileSync(file, '\n-- edited\n');
      const result = check(copy.dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`edited after production ran it`);
      expect(result.stderr).toContain(manifest.baseline.migrations[0]);
    } finally {
      fs.rmSync(copy.dir, { recursive: true, force: true });
    }
    // The shared tree was never touched
    expect(check().status).toBe(0);
  });

  it('a migration directory that is not in the manifest, and one in the manifest that is missing, are both caught', () => {
    const copy = isolated();
    try {
      fs.mkdirSync(path.join(copy.migrations, '20261119135001_not_in_the_manifest'));
      const extra = check(copy.dir);
      expect(extra.status).toBe(1);
      expect(extra.stderr).toContain('in prisma/migrations but not in the manifest: 20261119135001_not_in_the_manifest');
      fs.rmSync(path.join(copy.migrations, '20261119135001_not_in_the_manifest'), { recursive: true });
      const last = path.join(copy.migrations, manifest.shipping.lastMigration);
      fs.renameSync(last, `${last}.moved`);
      expect(check(copy.dir).stderr).toContain(`in the manifest but not in prisma/migrations: ${manifest.shipping.lastMigration}`);
    } finally {
      fs.rmSync(copy.dir, { recursive: true, force: true });
    }
    expect(fs.readdirSync(path.join(root, 'prisma/migrations')).filter((name) => name.endsWith('.moved') || name.includes('not_in_the_manifest'))).toEqual([]);
  });

  it('a migration added AFTER the manifest’s last one is caught for the active release; only an explicit historical cutoff leaves it out', () => {
    const copy = isolated();
    try {
      const later = '20261120130001_release_fix';
      expect(later > manifest.shipping.lastMigration).toBe(true);
      fs.mkdirSync(path.join(copy.migrations, later));
      fs.writeFileSync(path.join(copy.migrations, later, 'migration.sql'), 'SELECT 1;\n');
      const active = check(copy.dir);
      expect(active.status).toBe(1);
      expect(active.stderr).toContain(`in prisma/migrations but not in the manifest: ${later}`);
      // The historical check of the release as it shipped is a mode someone asks for by name
      expect(check(copy.dir, ['--through', manifest.shipping.lastMigration]).status).toBe(0);
      // A cutoff that is not one of the shipped migrations is refused, not guessed
      expect(check(copy.dir, ['--through', later]).status).toBe(1);
      // Writing the manifest adds it, and then the active check passes
      expect(check(copy.dir, ['--write']).status).toBe(0);
      expect(check(copy.dir).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(copy.dir, 'prisma/migration-manifest.json'), 'utf8')).shipping.lastMigration).toBe(later);
    } finally {
      fs.rmSync(copy.dir, { recursive: true, force: true });
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
