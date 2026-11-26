/**
 * Whose choice an App action's own setting is (bot_mcp_tools.setting_by_person), on a database upgraded with the real `prisma migrate deploy` (GPT audit
 * 26 Nov, finding 11). Only Universe's own GitHub starts Run a workflow on Asks first: a person's own App with a tool of the same name and the same choice
 * keeps it as the person's. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL whose user may create databases:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/migrations/app-action-choice-by-person-db.test.ts --runInBand
 */
import { createThrowaway, deploy, dropThrowaway, manifest, stage, type Throwaway } from '../helpers/migration-upgrade';

const run = process.env.ROLES_DB_TEST === 'yes' && process.env.DATABASE_URL ? describe : describe.skip;

// The last migration before setting_by_person: the state a database was in when these rows were written
const BEFORE = '20261126120000_tool_person_heading';

jest.setTimeout(600_000);

run('setting_by_person after the upgrade', () => {
  let db: Throwaway | undefined;
  const byPerson = async (id: string) => (await (db as Throwaway).client.query(`SELECT setting_by_person FROM bot_mcp_tools WHERE id = $1`, [id])).rows[0]?.setting_by_person;

  beforeAll(async () => {
    db = await createThrowaway('by_person');
    expect(deploy(db, stage(manifest.shipping.migrations.filter((name) => name <= BEFORE))).status).toBe(0);
    await db.client.query(`
      INSERT INTO users (id, uuid, updated_at) VALUES ('u-1', 'uuid-1', now());
      INSERT INTO bots (id, name, owner_id, updated_at) VALUES ('bot-1', 'Sara', 'u-1', now());
      INSERT INTO app_connections (id, owner_id, name, server_url, source, updated_at) VALUES
        ('conn-own', 'u-1', 'My deploy App', 'https://deploy.example.test/mcp', 'link', now()),
        ('conn-gh', 'u-1', 'GitHub', '', 'github', now());
      INSERT INTO bot_mcp_servers (id, bot_id, name, server_url, connection_id, updated_at) VALUES
        ('srv-own', 'bot-1', 'My deploy App', 'https://deploy.example.test/mcp', 'conn-own', now()),
        ('srv-gh', 'bot-1', 'GitHub', '', 'conn-gh', now()),
        ('srv-loose', 'bot-1', 'Old App', 'https://old.example.test/mcp', NULL, now());
      INSERT INTO bot_mcp_tools (id, server_id, name, fingerprint, setting, updated_at) VALUES
        ('own-run', 'srv-own', 'github_run_workflow', 'f1', 'asksFirst', now()),
        ('own-other', 'srv-own', 'deploy_now', 'f2', 'off', now()),
        ('own-none', 'srv-own', 'list_runs', 'f3', NULL, now()),
        ('loose-run', 'srv-loose', 'github_run_workflow', 'f4', 'asksFirst', now()),
        ('gh-run', 'srv-gh', 'github_run_workflow', 'f5', 'asksFirst', now()),
        ('gh-run-off', 'srv-gh', 'github_run_workflow_off', 'f6', 'off', now());
    `);
    const all = deploy(db);
    expect({ status: all.status, tail: all.out.slice(-200) }).toEqual({ status: 0, tail: expect.stringContaining('All migrations have been successfully applied') });
  });
  afterAll(() => dropThrowaway(db));

  it('keeps Run a workflow’s Asks first as the person’s choice on their own App with a tool of the same name, and on a grant with no connection', async () => {
    expect(await byPerson('own-run')).toBe(true);
    expect(await byPerson('loose-run')).toBe(true);
  });

  it('marks every other saved choice as the person’s, and a row with no choice as nobody’s', async () => {
    expect(await byPerson('own-other')).toBe(true);
    expect(await byPerson('gh-run-off')).toBe(true);
    expect(await byPerson('own-none')).toBe(false);
  });

  it('leaves Run a workflow’s Asks first on Universe’s own GitHub as Universe’s start', async () => {
    expect(await byPerson('gh-run')).toBe(false);
  });
});
