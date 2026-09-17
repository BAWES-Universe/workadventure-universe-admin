import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Journal, Binding } from "@/lib/linear-sh/journal";

// Explicit opt-in and exact disposable endpoint. Never use application DATABASE_URL or reset a database.
const optedIn = process.env.RUN_LINEAR_SH_DB_TESTS === "1";
const fixtureUrl =
  "postgresql://linear_sh:fixture@127.0.0.1:5432/linear_sh_disposable";
if (optedIn && process.env.LINEAR_SH_TEST_DATABASE_URL !== fixtureUrl)
  throw new Error("Disposable database required");
const suite = optedIn ? describe : describe.skip;
suite("Linear SH additive migration and real journal transactions", () => {
  it("applies only to an empty identified fixture DB, serializes previews/claims and retains outcomes after reconnect", async () => {
    const pool = new Pool({ connectionString: fixtureUrl });
    const clients: PrismaClient[] = [];
    const client = () => {
      const db = new PrismaClient({
        adapter: new PrismaPg({ connectionString: fixtureUrl }),
      });
      clients.push(db);
      return db;
    };
    try {
      const identity = (
        await pool.query(
          "SELECT current_database() AS db, current_user AS role",
        )
      ).rows[0];
      expect(identity).toEqual({
        db: "linear_sh_disposable",
        role: "linear_sh",
      });
      const tables = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      if (tables.rowCount !== 0)
        throw new Error(
          "Fixture database must be empty; will not reset or drop anything",
        );
      await pool.query(
        readFileSync(
          join(
            process.cwd(),
            "prisma/migrations/20260917120000_linear_sh_operations/migration.sql",
          ),
          "utf8",
        ),
      );
      const binding: Binding = {
        botId: "fixture-bot",
        connectionId: "fixture-connection",
        workspaceId: "fixture-workspace",
        appActorId: "fixture-app",
        schemaHash: "fixture",
        subject: "fixture-a",
        accountId: "fixture-account",
        linearUserId: "fixture-linear-a",
        teamIds: ["fixture-team"],
        conversation: "fixture-bubble",
        interactionId: "fixture-visit",
        requestId: "fixture-request",
        writesEnabled: true,
      };
      // A reversible synthetic codec: no credentials/provider calls; journal concurrency is under test.
      const makeJournal = (db: PrismaClient) =>
        new Journal(
          db,
          (s) => Buffer.from(s).toString("base64"),
          (s) => Buffer.from(s, "base64").toString(),
        );
      const firstDb = client();
      const a = makeJournal(firstDb);
      const b = makeJournal(client());
      const items = [
        {
          kind: "create",
          args: {
            title: "Fictional task",
            team: "fixture-team",
            assignee: "fixture-linear-a",
          },
        },
      ];
      const previews = await Promise.all([
        a.prepare(binding, items),
        b.prepare(binding, items),
      ]);
      expect(previews[0].id).toBe(previews[1].id);
      const op = previews[0];
      const claims = await Promise.all([
        a.claim(binding, op.id, op.hash),
        b.claim(binding, op.id, op.hash),
      ]);
      expect(claims.filter((r) => r.claimed)).toHaveLength(1);
      await a.record(binding, op.id, 0, { status: "dispatched" });
      await firstDb.$disconnect();
      const restarted = makeJournal(client());
      expect((await restarted.claim(binding, op.id, op.hash)).claimed).toBe(
        false,
      );
      expect((await restarted.lookup(binding, op.id)).results).toEqual([
        { status: "dispatched" },
      ]);
      await restarted.record(binding, op.id, 0, { status: "unknown" });
      await expect(
        restarted.record(binding, op.id, 0, { status: "success" }),
      ).rejects.toThrow();
      await expect(
        restarted.lookup({ ...binding, interactionId: "next-visitor" }, op.id),
      ).rejects.toThrow();
    } finally {
      await Promise.all(clients.map((db) => db.$disconnect()));
      await pool.end();
    }
  });
});
