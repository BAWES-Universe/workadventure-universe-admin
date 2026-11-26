/**
 * Upgrading a POPULATED database to the 0.5.0 migrations with the real `prisma migrate deploy` (GPT money review O6). Three databases, each built by the real
 * CLI with only the migrations its state had, filled with rows the way that state's code wrote them, then deployed with the whole directory:
 *
 *   A. production today: tag v0.3.44 (77 migrations), people, universes, rooms, bots, access rules, thousands of usage rows;
 *   B. an environment part-way through 0.5.0 (every migration before the money fixes): open holds, a lease with no terms, running and ended jobs, receipts,
 *      Instant runs and a refund waiting, orders in flight, a key form with a try held, copies waiting for deletion, the saved allowance;
 *   C. B, after the standalone #1013 branch's migration `20261119135000_app_key_holds` (superseded, not shipped) was applied and a hold row written.
 *
 * Each ends with: every migration of the manifest finished and none failed, the rows still there, no drift from schema.prisma (C: only the unused table),
 * the statements an OLDER worker still sends working against the new tables, and the real code reading what the upgrade left. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL whose user may create databases:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/migrations/upgrade-from-populated-db.test.ts
 */
import path from 'node:path';
import { counts, createThrowaway, deploy, drift, dropThrowaway, expectDeployed, history, manifest, stage, withApplication, type Throwaway } from '../helpers/migration-upgrade';

const run = process.env.ROLES_DB_TEST === 'yes' && process.env.DATABASE_URL ? describe : describe.skip;

// Every migration before the money fixes of the last two days: what a development or staging database had when the work was half done
const MID_WAVE = '20261118200000_brick_run_universe_ai';
const STANDALONE = '20261119135000_app_key_holds';
const standaloneFolder = path.join(__dirname, '../fixtures/superseded-migrations', STANDALONE);
const midWave = () => manifest.shipping.migrations.filter((name) => name <= MID_WAVE);

jest.setTimeout(900_000);

const users = (client: Throwaway['client']) =>
  client.query(`
    INSERT INTO users (id, uuid, updated_at) VALUES ('u-owner', 'uuid-owner', now()), ('u-buyer', 'uuid-buyer', now());
    INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('uni1', 'acme', 'Acme', 'u-owner', now());
    INSERT INTO worlds (id, universe_id, slug, name, updated_at) VALUES ('w1', 'uni1', 'hq', 'HQ', now());
    INSERT INTO rooms (id, world_id, slug, name, updated_at) VALUES ('room1', 'w1', 'lobby', 'Lobby', now());
    INSERT INTO bots (id, room_id, name, updated_at) VALUES ('bot-room', 'room1', 'Nora', now()), ('bot-room-2', 'room1', 'Atlas', now());
    INSERT INTO bots_ai_providers (provider_id, name, type, updated_at) VALUES ('prov-1', 'Provider', 'openai', now());
    INSERT INTO bots_ai_usage (bot_id, provider_id) SELECT 'bot-room', 'prov-1' FROM generate_series(1, 3000);
  `);

describe('the real upgrade', () => {
  let a: Throwaway | undefined;
  let b: Throwaway | undefined;
  let c: Throwaway | undefined;
  afterAll(async () => {
    await Promise.all([dropThrowaway(a), dropThrowaway(b), dropThrowaway(c)]);
  });

  run('from production today (v0.3.44, 77 migrations) with its rows', () => {
    let before: Record<string, number>;
    beforeAll(async () => {
      a = await createThrowaway('prod');
      const first = deploy(a, stage(manifest.baseline.migrations));
      expect(first.status).toBe(0);
      await users(a.client);
      await a.client.query(`
        INSERT INTO bot_access_rules (id, bot_id, user_id, allow, deny, updated_at) VALUES ('rule-1', 'bot-room', 'u-buyer', 8192 + 16384, 65536, now());
        INSERT INTO bots_ai_usage (bot_id, provider_id, talked_person_id) SELECT 'bot-room-2', 'prov-1', 'u-buyer' FROM generate_series(1, 50);
      `);
      before = await counts(a.client, ['app_settings']);
      const second = deploy(a);
      expectDeployed(second);
    });

    it('applies every migration of the manifest once, none failed, and the history is the baseline plus the new ones', async () => {
      const state = await history((a as Throwaway).client);
      expect(state).toMatchObject({ unfinished: 0, rolledBack: 0 });
      expect(state.applied).toEqual([...manifest.shipping.migrations].sort());
      expect(state.applied).toHaveLength(manifest.shipping.count);
    });

    it('keeps every row of every table it had, and the schema equals schema.prisma (nothing left over, nothing missing)', async () => {
      const after = await counts((a as Throwaway).client, ['app_settings']);
      for (const [table, n] of Object.entries(before)) expect({ table, n: after[table] }).toEqual({ table, n });
      expect(drift(a as Throwaway)).toBe('');
    });

    it('turns on what the release turns on for people who already exist: visiting Bricks on every universe, Call at No on every rule, room bots unchanged', async () => {
      const { client } = a as Throwaway;
      expect((await client.query(`SELECT allow_visiting_bricks FROM universes`)).rows).toEqual([{ allow_visiting_bricks: true }]);
      expect((await client.query(`SELECT allow::int AS allow, deny::int AS deny FROM bot_access_rules WHERE id = 'rule-1'`)).rows).toEqual([{ allow: 8192 + 16384, deny: 65536 }]);
      expect((await client.query(`SELECT id, room_id, owner_id, allow_more_idle_minutes, allow_more_max_minutes FROM bots ORDER BY id`)).rows).toEqual([
        { id: 'bot-room', room_id: 'room1', owner_id: null, allow_more_idle_minutes: 60, allow_more_max_minutes: 480 },
        { id: 'bot-room-2', room_id: 'room1', owner_id: null, allow_more_idle_minutes: 60, allow_more_max_minutes: 480 },
      ]);
    });

    it('builds the unique usage-report index over the usage rows it already holds (none has a key yet), and it is valid', async () => {
      const { client } = a as Throwaway;
      expect((await client.query(`SELECT count(*)::int AS n, count(report_key)::int AS keyed FROM bots_ai_usage`)).rows).toEqual([{ n: 3050, keyed: 0 }]);
      expect((await client.query(`SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = 'bots_ai_usage_report_key_key'::regclass`)).rows).toEqual([{ indisvalid: true, indisunique: true }]);
    });

    it('lets an OLDER worker (the v0.3.44 statements) go on writing while the new version rolls out', async () => {
      const { client } = a as Throwaway;
      await client.query(`INSERT INTO bots (id, room_id, name, updated_at) VALUES ('old-writes', 'room1', 'Written by the old version', now())`);
      await client.query(`INSERT INTO universes (id, slug, name, owner_id, updated_at) VALUES ('uni-old', 'old', 'Old', 'u-owner', now())`);
      await client.query(`INSERT INTO bots_ai_usage (bot_id, provider_id) VALUES ('bot-room', 'prov-1'), ('bot-room', 'prov-1')`);
      await client.query(`UPDATE bots SET name = 'Renamed by the old version' WHERE id = 'old-writes'`);
      // What the new tables let an old row be: a room bot still has exactly one place, and an old worker's universe is on the new default (visiting Bricks on)
      await expect(client.query(`INSERT INTO bots (id, room_id, owner_id, name, updated_at) VALUES ('both', 'room1', 'u-owner', 'Two places', now())`)).rejects.toThrow(/bots_room_or_owner/);
      expect((await client.query(`SELECT allow_visiting_bricks FROM universes WHERE id = 'uni-old'`)).rows).toEqual([{ allow_visiting_bricks: true }]);
    });
  });

  run('from an environment part-way through 0.5.0, with open holds, jobs, orders and older leases', () => {
    const NOW = new Date();
    let before: Record<string, number>;

    const seed = async (db: Throwaway) => {
      await users(db.client);
      await db.client.query(`
        INSERT INTO bots (id, owner_id, name, updated_at) VALUES ('bot-a', 'u-owner', 'Brick A', now()), ('bot-b', 'u-owner', 'Brick B', now()), ('bot-c', 'u-owner', 'Brick C', now());
        INSERT INTO brick_computers (id, bot_id, updated_at, machine, provider) VALUES ('bc-a', 'bot-a', now(), 'working', 'fake');

        -- jobs: one running on a lease that has been renewed twice (no terms: written before they existed), one done, one failed
        INSERT INTO computer_jobs (id, bot_id, person_id, title, status, started_at, created_at, reservation_key, seconds_run)
          VALUES ('job-run', 'bot-a', 'u-owner', 'Running job', 'running', now() - interval '20 minutes', now() - interval '25 minutes', 'lease-old', 1200);
        INSERT INTO computer_jobs (id, bot_id, person_id, title, status, started_at, created_at, ended_at, ended_by)
          VALUES ('job-done', 'bot-b', 'u-owner', 'Done job', 'done', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours', NULL),
                 ('job-failed', 'bot-c', 'u-owner', 'Failed job', 'failed', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours', 'error');

        -- holds: an open lease (renewed twice, no terms), a settled one
        INSERT INTO meter_reservations (id, reservation_key, person_key, person_id, bot_id, job_id, amount_micros, state, expires_at, renewals, created_at)
          VALUES ('res-old', 'lease-old', 'person:u-owner', 'u-owner', 'bot-a', 'job-run', 5000000, 'held', now() + interval '10 minutes', 2, now() - interval '30 minutes');
        INSERT INTO meter_reservations (id, reservation_key, person_key, person_id, amount_micros, state, expires_at, renewals, settled_micros, closed_at)
          VALUES ('res-settled', 'lease-settled', 'person:u-owner', 'u-owner', 2000000, 'settled', now() - interval '1 day', 0, 1500000, now() - interval '1 day');

        -- Instant: a hold taken and nothing sent, one that succeeded and was charged (its meter line was never written), one sent and not answered, a give-back waiting
        INSERT INTO instant_runs (id, run_key, bot_id, person_id, tool_slug, toolkit, args_hash, price_version, top_micros, hold_micros, state, customer_state, provider_user_id)
          VALUES ('run-held', 'key-1', 'bot-a', 'u-owner', 'GMAIL_SEND_EMAIL', 'gmail', 'h1', 'v1', 10000, 7600, 'held', 'held', 'prov-user');
        INSERT INTO instant_runs (id, run_key, bot_id, person_id, tool_slug, toolkit, args_hash, price_version, top_micros, hold_micros, state, customer_state, customer_micros, provider_state, provider_micros, provider_basis, provider, sent_at, finished_at, provider_user_id)
          VALUES ('run-charged', 'key-2', 'bot-a', 'u-owner', 'GMAIL_SEND_EMAIL', 'gmail', 'h2', 'v1', 10000, 7600, 'succeeded', 'charged', 7600, 'settled', 5000, 'measured', 'composio', now() - interval '3 hours', now() - interval '3 hours', 'prov-user');
        INSERT INTO instant_runs (id, run_key, bot_id, person_id, tool_slug, toolkit, args_hash, price_version, top_micros, hold_micros, state, customer_state, provider_state, sent_at, provider_user_id)
          VALUES ('run-sent', 'key-3', 'bot-a', 'u-owner', 'EXA_SEARCH', 'exa', 'h3', 'v1', 10000, 7600, 'sent', 'held', 'pending', now() - interval '10 minutes', 'prov-user');
        INSERT INTO instant_refunds (id, refund_key, run_id, person_id, kind, amount_micros) VALUES ('ref-1', 'rk-1', 'run-held', 'u-owner', 'goodwill', 500);

        -- receipts: two running (an Apps task, a computer's), one done, one refunded, one being checked
        INSERT INTO task_receipts (id, bot_id, person_id, task_key, title, category, state, payer_kind) VALUES
          ('r-run-apps', 'bot-a', 'u-owner', 't1', 'Running Apps task', 'apps', 'running', 'person'),
          ('r-run-computer', 'bot-a', 'u-owner', 't2', 'Running computer task', 'computer', 'running', 'person'),
          ('r-done', 'bot-a', 'u-owner', 't3', 'Done task', 'apps', 'done', 'person'),
          ('r-refunded', 'bot-a', 'u-owner', 't4', 'Refunded task', 'apps', 'refunded', 'person'),
          ('r-checking', 'bot-a', 'u-owner', 't5', 'Checked task', 'apps', 'checking', 'person');

        -- checkout: one order waiting for payment, one paid
        INSERT INTO app_page_orders (id, owner_id, artifact_id, definition_hash, amount_minor, currency, visitor_hash, status, created_at) VALUES
          ('ord-pending', 'u-owner', 'art-1', 'dh', 500, 'USD', 'visitor-1', 'pending', now() - interval '5 minutes'),
          ('ord-paid', 'u-owner', 'art-1', 'dh', 500, 'USD', 'visitor-2', 'paid', now() - interval '1 day');

        -- a key form with one try held (reserved) and two used
        INSERT INTO app_key_requests (id, owner_id, definition, definition_hash, expires_at, tries, reserved_tries, reserved_at)
          VALUES ('akr-1', 'u-owner', '{}'::jsonb, 'dh', now() + interval '1 day', 2, 1, now());

        -- the allowance as saved before the history of allowances existed, with a later one waiting
        INSERT INTO app_settings (key, value, updated_at) VALUES ('meter', '{"memberAllowanceMicros": 3000000, "memberAllowanceLater": {"from": "2099-12-01T00:00:00", "micros": 4000000}}'::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

        -- cold-storage copies: one superseded and waiting to be deleted, one verified
        INSERT INTO computer_archives (id, bot_id, generation, state, object_key) VALUES
          ('arch-waiting', 'bot-a', 1, 'superseded', 'computer-cold/bot-a/1.arch-waiting.ubc'),
          ('arch-ok', 'bot-a', 2, 'verified', 'computer-cold/bot-a/2.arch-ok.ubc');
      `);
    };

    const upgrade = async (db: Throwaway) => {
      before = await counts(db.client, ['app_settings']);
      const result = deploy(db);
      expectDeployed(result);
    };

    beforeAll(async () => {
      b = await createThrowaway('mid');
      expect(deploy(b, stage(midWave())).status).toBe(0);
      await seed(b);
      await upgrade(b);
    });

    it('applies the rest of the manifest, none failed, and no migration the manifest does not list ever ran', async () => {
      const state = await history((b as Throwaway).client);
      expect(state).toMatchObject({ unfinished: 0, rolledBack: 0 });
      expect(state.applied).toEqual([...manifest.shipping.migrations].sort());
    });

    it('keeps every row of every table it had and the schema equals schema.prisma', async () => {
      const after = await counts((b as Throwaway).client, ['app_settings']);
      for (const [table, n] of Object.entries(before)) {
        // The only table whose rows the upgrade may add to is the allowance history (written from the saved setting)
        if (table === 'meter_allowance_changes') continue;
        expect({ table, n: after[table] }).toEqual({ table, n });
      }
      expect(drift(b as Throwaway)).toBe('');
    });

    it('builds the two indexes made CONCURRENTLY (a failed one is left invalid and unused) and they are valid', async () => {
      const { client } = b as Throwaway;
      const rows = (await client.query(`SELECT c.relname, i.indisvalid, i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('app_page_orders_artifact_id_buyer_key_intent_id_key', 'app_page_orders_artifact_id_buyer_key_status_idx') ORDER BY 1`)).rows;
      expect(rows).toEqual([
        { relname: 'app_page_orders_artifact_id_buyer_key_intent_id_key', indisvalid: true, indisunique: true },
        { relname: 'app_page_orders_artifact_id_buyer_key_status_idx', indisvalid: true, indisunique: false },
      ]);
      // Orders in flight have no wish or buyer yet, and are never equal to each other for the one-order-per-wish rule
      expect((await client.query(`SELECT id, status, intent_id, buyer_key FROM app_page_orders ORDER BY id`)).rows).toEqual([
        { id: 'ord-paid', status: 'paid', intent_id: null, buyer_key: null },
        { id: 'ord-pending', status: 'pending', intent_id: null, buyer_key: null },
      ]);
    });

    it('leaves the open holds exactly as they were: the lease is still held, still renewed twice, and has no terms (an older row)', async () => {
      const { client } = b as Throwaway;
      expect((await client.query(`SELECT id, state, renewals, amount_micros::int AS amount, terms FROM meter_reservations ORDER BY id`)).rows).toEqual([
        { id: 'res-old', state: 'held', renewals: 2, amount: 5_000_000, terms: null },
        { id: 'res-settled', state: 'settled', renewals: 0, amount: 2_000_000, terms: null },
      ]);
      expect((await client.query(`SELECT customer_state, state FROM instant_runs ORDER BY id`)).rows).toEqual([
        { customer_state: 'charged', state: 'succeeded' },
        { customer_state: 'held', state: 'held' },
        { customer_state: 'held', state: 'sent' },
      ]);
      expect((await client.query(`SELECT tries, reserved_tries, reserved_epoch FROM app_key_requests`)).rows).toEqual([{ tries: 2, reserved_tries: 1, reserved_epoch: 0 }]);
      expect((await client.query(`SELECT id, runner_fault, prepare_claimed_at, first_turn_sent_at FROM computer_jobs ORDER BY id`)).rows).toEqual([
        { id: 'job-done', runner_fault: false, prepare_claimed_at: null, first_turn_sent_at: null },
        { id: 'job-failed', runner_fault: false, prepare_claimed_at: null, first_turn_sent_at: null },
        { id: 'job-run', runner_fault: false, prepare_claimed_at: null, first_turn_sent_at: null },
      ]);
    });

    it('gives a running Apps receipt a fresh lease, a computer’s none, and an ended one the outcome its state already said', async () => {
      const { client } = b as Throwaway;
      const rows = (await client.query(`SELECT id, state, outcome, generation, lease_until IS NOT NULL AS leased, lease_until > (now() AT TIME ZONE 'UTC') AS in_future FROM task_receipts ORDER BY id`)).rows;
      expect(rows).toEqual([
        { id: 'r-checking', state: 'checking', outcome: null, generation: 1, leased: false, in_future: null },
        { id: 'r-done', state: 'done', outcome: 'done', generation: 1, leased: false, in_future: null },
        { id: 'r-refunded', state: 'refunded', outcome: 'refunded', generation: 1, leased: false, in_future: null },
        { id: 'r-run-apps', state: 'running', outcome: null, generation: 1, leased: true, in_future: true },
        { id: 'r-run-computer', state: 'running', outcome: null, generation: 1, leased: false, in_future: null },
      ]);
    });

    it('writes the allowance history from the saved setting (today’s from the beginning, the later one from its day) and counts copies already waiting from now', async () => {
      const { client } = b as Throwaway;
      expect((await client.query(`SELECT to_char(effective_from, 'YYYY-MM-DD') AS from, allowance_micros::int AS micros FROM meter_allowance_changes ORDER BY effective_from`)).rows).toEqual([
        { from: '1970-01-01', micros: 3_000_000 },
        { from: '2099-12-01', micros: 4_000_000 },
      ]);
      expect((await client.query(`SELECT id, deletion_since IS NOT NULL AS waiting FROM computer_archives ORDER BY id`)).rows).toEqual([
        { id: 'arch-ok', waiting: false },
        { id: 'arch-waiting', waiting: true },
      ]);
    });

    it('lets an OLDER worker (the statements of the state it was in) go on writing during the roll-out', async () => {
      const { client } = b as Throwaway;
      await client.query(`INSERT INTO task_receipts (id, bot_id, person_id, task_key, title, category, state, payer_kind) VALUES ('r-old', 'bot-a', 'u-owner', 't-old', 'Written by the old version', 'apps', 'running', 'person')`);
      await client.query(`INSERT INTO meter_reservations (id, reservation_key, person_key, amount_micros, state, expires_at) VALUES ('res-older', 'lease-older', 'person:u-owner', 1000000, 'held', now() + interval '10 minutes')`);
      await client.query(`INSERT INTO app_page_orders (id, owner_id, artifact_id, definition_hash, amount_minor, currency, visitor_hash, status) VALUES ('ord-old', 'u-owner', 'art-1', 'dh', 500, 'USD', 'visitor-3', 'pending')`);
      await client.query(`INSERT INTO app_page_orders (id, owner_id, artifact_id, definition_hash, amount_minor, currency, visitor_hash, status) VALUES ('ord-old-2', 'u-owner', 'art-1', 'dh', 500, 'USD', 'visitor-4', 'pending')`);
      await client.query(`INSERT INTO bots_ai_usage (bot_id, provider_id) VALUES ('bot-room', 'prov-1'), ('bot-room', 'prov-1')`);
      expect((await client.query(`SELECT generation, lease_until FROM task_receipts WHERE id = 'r-old'`)).rows).toEqual([{ generation: 1, lease_until: null }]);
    });

    it('is read by the real code: the old lease is counted, the charged run gets its meter line, the copy waiting is seen', async () => {
      await withApplication(b as Throwaway, async () => {
        const { heldRoom } = await import('@/lib/meter-allowance');
        const { repairInstantReporting } = await import('@/lib/instant/report');
        const { storageDeletionsWaiting } = await import('@/lib/computer-archives');
        const { prisma } = await import('@/lib/db');
        // A lease from before terms existed is counted as equal stretches, never refused or counted as nothing
        expect(await heldRoom('u-owner', NOW)).toBeGreaterThan(0);
        // The run that succeeded and was charged has no line in the books yet: the repair writes it, once, from the run
        const first = await repairInstantReporting({ now: NOW });
        expect(first.failed).toBe(0);
        const lines = await prisma.meterEvent.findMany({ where: { eventId: { startsWith: 'instant:' } }, select: { eventId: true, costMicros: true } });
        expect(lines.map((line) => line.eventId)).toContain('instant:run-charged');
        expect(Number(lines.find((line) => line.eventId === 'instant:run-charged')?.costMicros)).toBeGreaterThan(0);
        await repairInstantReporting({ now: NOW });
        expect(await prisma.meterEvent.count({ where: { eventId: 'instant:run-charged' } })).toBe(1);
        const waiting = await storageDeletionsWaiting(new Date(NOW.getTime() + 3_600_000));
        expect(waiting.count).toBe(1);
        expect(waiting.ageMs).toBeGreaterThan(0);
      });
    });
  });

  run('from an environment that also applied the standalone key-form holds migration (superseded)', () => {
    beforeAll(async () => {
      c = await createThrowaway('standalone');
      // History as that environment had it: everything before the money fixes, and the standalone migration the release does not ship
      expect(deploy(c, stage(midWave(), [{ name: STANDALONE, from: standaloneFolder }])).status).toBe(0);
      await users(c.client);
      await c.client.query(`
        INSERT INTO app_key_requests (id, owner_id, definition, definition_hash, expires_at, tries, reserved_tries, reserved_at)
          VALUES ('akr-1', 'u-owner', '{}'::jsonb, 'dh', now() + interval '1 day', 2, 1, now());
        INSERT INTO app_key_holds (id, request_id, expires_at) VALUES ('hold-1', 'akr-1', now() + interval '5 minutes');
      `);
    });

    it('deploys the shipping directory over it without error: the standalone migration stays recorded as applied, every shipped migration runs', async () => {
      const result = deploy(c as Throwaway);
      expectDeployed(result);
      const state = await history((c as Throwaway).client);
      expect(state).toMatchObject({ unfinished: 0, rolledBack: 0 });
      expect(state.applied).toEqual([...manifest.shipping.migrations, STANDALONE].sort());
      expect(state.applied).toHaveLength(manifest.shipping.count + 1);
    });

    it('leaves exactly one difference from schema.prisma: the unused table and its foreign key (what the docs say to drop by hand)', () => {
      const difference = drift(c as Throwaway);
      expect(difference).toContain('DROP TABLE "app_key_holds"');
      expect(difference.replace(/--.*\n?/g, '').split(';').map((statement) => statement.trim()).filter(Boolean)).toEqual([
        'ALTER TABLE "app_key_holds" DROP CONSTRAINT "app_key_holds_request_id_fkey"',
        'DROP TABLE "app_key_holds"',
      ]);
    });

    it('keeps the form and its count the way the shipping design reads them (reserved epoch 0, a try held), and the unused hold row never blocks the form', async () => {
      const { client } = c as Throwaway;
      expect((await client.query(`SELECT tries, reserved_tries, reserved_epoch FROM app_key_requests`)).rows).toEqual([{ tries: 2, reserved_tries: 1, reserved_epoch: 0 }]);
      // The hold row is nothing the release reads: deleting the form (its owner’s account, a purge) still works and takes the row with it
      await client.query(`DELETE FROM app_key_requests WHERE id = 'akr-1'`);
      expect((await client.query(`SELECT count(*)::int AS n FROM app_key_holds`)).rows).toEqual([{ n: 0 }]);
    });
  });
});
