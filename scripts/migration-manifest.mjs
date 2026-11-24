#!/usr/bin/env node
// The exact list of migrations a release ships (prisma/migration-manifest.json) against the directories in prisma/migrations.
//
//   node scripts/migration-manifest.mjs                      checks the manifest against the WHOLE directory; exits 1 and says what differs
//   node scripts/migration-manifest.mjs --write              rewrites the shipping list (and the list in docs/RELEASE-0.5.0-MIGRATIONS.md) from the directory
//   node scripts/migration-manifest.mjs --through <name>     historical check: only the migrations up to and including <name> (a release already shipped, read
//                                                            from a tree that has moved on); never the default, so a migration added after the manifest's last one is caught
//
// A migration added for the release is added to the directory and this is run with --write, so the list a reviewer reads is the one that deploys.
// Prisma deploys the whole directory, so the active release is checked against the whole directory: nothing is excused by its name sorting after `lastMigration`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'prisma/migration-manifest.json');
const docPath = path.join(root, 'docs/RELEASE-0.5.0-MIGRATIONS.md');
const START = '<!-- migrations:start -->';
const END = '<!-- migrations:end -->';

export const directoryNames = () =>
  fs
    .readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8,14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

export const listFor = (names) => names.map((name, index) => `${String(index + 1).padStart(3, ' ')}. \`${name}\``).join('\n');

/**
 * What differs between the manifest and the directory, in words ([] when they agree). The whole directory is in scope unless a historical cutoff
 * (`through`) is given explicitly: then only the migrations up to it are compared.
 */
export function differences(manifest, names, { through = null } = {}) {
  const last = manifest.shipping.lastMigration;
  const inScope = through === null ? names : names.filter((name) => name <= through);
  const listed = through === null ? manifest.shipping.migrations : manifest.shipping.migrations.filter((name) => name <= through);
  const problems = [];
  for (const name of inScope) if (!listed.includes(name)) problems.push(`in prisma/migrations but not in the manifest: ${name}`);
  for (const name of listed) if (!names.includes(name)) problems.push(`in the manifest but not in prisma/migrations: ${name}`);
  if (through !== null && !manifest.shipping.migrations.includes(through)) problems.push(`the cutoff is not a migration in the manifest: ${through}`);
  const all = manifest.shipping.migrations;
  if (manifest.shipping.count !== all.length) problems.push(`count says ${manifest.shipping.count} but ${all.length} are listed`);
  if (all.some((name, index) => index > 0 && all[index - 1] >= name)) problems.push('the shipping list is not in strictly increasing order');
  if (through === null && listed.length > 0 && listed[listed.length - 1] !== last) problems.push(`lastMigration is ${last} but the list ends with ${listed[listed.length - 1]}`);
  for (const old of manifest.superseded) if (names.includes(old.name) || listed.includes(old.name)) problems.push(`superseded and still shipped: ${old.name}`);
  // Every migration production already ran is shipped: asked of the manifest's whole list, because a historical cutoff only narrows what is compared with the directory
  for (const name of manifest.baseline.migrations) if (!all.includes(name)) problems.push(`in the v0.3.44 baseline but not shipped: ${name}`);
  // A migration production already ran must not change: Prisma refuses to deploy over one whose file differs from what it recorded
  for (const name of manifest.baseline.migrations) {
    const file = path.join(root, 'prisma/migrations', name, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (sum !== manifest.baseline.checksums[name]) problems.push(`edited after production ran it (its checksum is not the one of v0.3.44): ${name}`);
  }
  return problems;
}

/**
 * The command line, read and checked BEFORE anything is written: `--write` alone rewrites the list; `--through <name>` alone is the historical check; nothing else.
 * Returns { write, through } or { error }.
 */
export function parseArguments(args) {
  const known = new Set(['--write', '--through']);
  const write = args.includes('--write');
  const cut = args.indexOf('--through');
  if (cut >= 0) {
    const operand = args[cut + 1];
    if (operand === undefined || operand === '' || operand.startsWith('--')) return { error: '--through needs the name of the last migration to compare' };
    if (write) return { error: '--write and --through cannot be used together (a historical check never rewrites the list)' };
  }
  const rest = args.filter((arg, index) => !(known.has(arg) || (cut >= 0 && index === cut + 1)));
  if (rest.length > 0) return { error: `unknown argument: ${rest[0]}` };
  return { write, through: cut >= 0 ? args[cut + 1] : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const names = directoryNames();
  if (parsed.write) {
    manifest.shipping = { lastMigration: names[names.length - 1], count: names.length, migrations: names };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const doc = fs.readFileSync(docPath, 'utf8');
    const from = doc.indexOf(START);
    const to = doc.indexOf(END);
    if (from < 0 || to < from) throw new Error(`${docPath} has no ${START} ... ${END} region`);
    fs.writeFileSync(docPath, `${doc.slice(0, from + START.length)}\n${listFor(names)}\n${doc.slice(to)}`);
    console.log(`Wrote ${names.length} migrations (last ${names[names.length - 1]}).`);
  } else {
    const problems = differences(manifest, names, { through: parsed.through });
    if (problems.length > 0) {
      console.error(`${problems.join('\n')}\n\nA migration added on purpose for this release: run node scripts/migration-manifest.mjs --write`);
      process.exit(1);
    }
    console.log(`The manifest matches prisma/migrations (${manifest.shipping.count} migrations, last ${manifest.shipping.lastMigration}).`);
  }
}
