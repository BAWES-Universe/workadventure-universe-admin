/* eslint-disable @typescript-eslint/no-explicit-any -- This database double intentionally models only the Prisma operations exercised below. */
import { Journal, Binding } from "@/lib/linear-sh/journal";
import { encryptApiKey, decryptApiKey } from "@/lib/encryption";
import type { RequestProof } from "@/lib/linear-sh/tickets";

const b: Binding = {
  subject: "subject-a",
  accountId: "account-a",
  linearUserId: "linear-a",
  workspaceId: "workspace",
  teamIds: ["team-a"],
  botId: "bot",
  connectionId: "mcp",
  appActorId: "app",
  conversation: "bubble",
  interactionId: "interaction-a",
  requestId: "request-1",
  writesEnabled: true,
  schemaHash: "fixture",
};
const items = [
  {
    kind: "create",
    args: { team: "team-a", title: "Fictional title", assignee: "linear-a" },
  },
];

// Persistent-in-test repository double with atomic CAS semantics. This is NOT PostgreSQL acceptance.
function repository() {
  const rows = new Map<string, any>();
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]: [string, any]) =>
      value?.gt instanceof Date ? row[key] > value.gt : row[key] === value,
    );
  const model = {
    findUnique: jest.fn(
      async ({ where }) =>
        [...rows.values()].find((r) => matches(r, where)) ?? null,
    ),
    findFirst: jest.fn(
      async ({ where }) =>
        [...rows.values()].find((r) => matches(r, where)) ?? null,
    ),
    create: jest.fn(async ({ data }) => {
      const row = { ...data, status: "pending" };
      rows.set(row.id, row);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      for (const row of rows.values())
        if (matches(row, where)) {
          Object.assign(row, data);
          count++;
        }
      return { count };
    }),
    update: jest.fn(async ({ where, data }) => {
      Object.assign(rows.get(where.id), data);
      return rows.get(where.id);
    }),
  };
  let queue = Promise.resolve();
  const db: any = {
    linearShOperation: model,
    $executeRaw: jest.fn(async () => 1),
    $transaction: (fn: any) => {
      const next = queue.then(() => fn(db));
      queue = next.catch(() => undefined);
      return next;
    },
  };
  return { db, rows };
}
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "cd".repeat(32);
});
afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("Linear SH durable confirmation boundary", () => {
  it("stores encrypted payload + attribution, deduplicates request IDs and rejects changed content", async () => {
    const { db, rows } = repository();
    const journal = new Journal(db, encryptApiKey, decryptApiKey, () => 0);
    const first = await journal.prepare(b, items);
    expect((await journal.prepare(b, items)).id).toBe(first.id);
    expect(rows.size).toBe(1);
    expect(rows.get(first.id)).toMatchObject({
      accountId: "account-a",
      linearUserId: "linear-a",
      appActorId: "app",
    });
    expect(rows.get(first.id).payload).not.toContain("Fictional title");
    await expect(
      journal.prepare(b, [
        { ...items[0], args: { ...items[0].args, title: "Changed" } },
      ]),
    ).rejects.toThrow("changed");
  });
  it("only one concurrent claim wins; a new Journal instance cannot replay after restart", async () => {
    const { db } = repository();
    const journal = new Journal(db, encryptApiKey, decryptApiKey, () => 0);
    const op = await journal.prepare(b, items);
    const result = await Promise.all([
      journal.claim(b, op.id, op.hash),
      journal.claim(b, op.id, op.hash),
    ]);
    expect(result.filter((r) => r.claimed)).toHaveLength(1);
    const restarted = new Journal(db, encryptApiKey, decryptApiKey, () => 1);
    expect((await restarted.claim(b, op.id, op.hash)).claimed).toBe(false);
    await restarted.record(b, op.id, 0, { status: "dispatched" });
    expect(
      (await new Journal(db, encryptApiKey, decryptApiKey).lookup(b, op.id))
        .results,
    ).toEqual([{ status: "dispatched" }]);
    await restarted.record(b, op.id, 0, { status: "unknown" });
    await expect(
      restarted.record(b, op.id, 0, { status: "success", issueId: "invented" }),
    ).rejects.toThrow();
  });
  it("denies cross-user/workspace/connection confirmations, expired previews and altered hashes", async () => {
    const { db } = repository();
    let now = 0;
    const journal = new Journal(db, encryptApiKey, decryptApiKey, () => now);
    const op = await journal.prepare(b, items);
    for (const changed of [
      { subject: "other" },
      { workspaceId: "other" },
      { connectionId: "other" },
      { interactionId: "returning-a" },
    ])
      await expect(
        journal.claim({ ...b, ...changed }, op.id, op.hash),
      ).rejects.toThrow();
    expect((await journal.claim(b, op.id, "wrong")).claimed).toBe(false);
    now = 300001;
    expect((await journal.claim(b, op.id, op.hash)).claimed).toBe(false);
  });
  it("supersedes old previews; denies hidden upsert fields, disabled writes, wrong teams and assignment", async () => {
    const { db } = repository();
    const journal = new Journal(db, encryptApiKey, decryptApiKey, () => 0);
    const old = await journal.prepare(b, items);
    await journal.prepare({ ...b, requestId: "request-2" }, items);
    expect((await journal.lookup(b, old.id)).status).toBe("superseded");
    expect((await journal.claim(b, old.id, old.hash)).claimed).toBe(false);
    await expect(
      journal.prepare({ ...b, writesEnabled: false }, items),
    ).rejects.toThrow();
    for (const changed of [
      { assignee: "someone-else" },
      { team: "outside" },
      { id: "hidden-upsert" },
      { labels: ["x"] },
    ])
      await expect(
        journal.prepare(b, [
          { kind: "create", args: { ...items[0].args, ...changed } },
        ]),
      ).rejects.toThrow();
  });
  it("retains a dispatched outcome after an expired interaction without exposing it to the next visitor", async () => {
    const { db } = repository();
    const journal = new Journal(db, encryptApiKey, decryptApiKey, () => 0);
    const op = await journal.prepare(b, items);
    await journal.claim(b, op.id, op.hash);
    await journal.record(b, op.id, 0, { status: "dispatched" });
    const proof: RequestProof = {
      ...b,
      kind: "request",
      senderId: "socket",
      spaceName: "bubble",
      messageHash: "fixture",
      expiresAt: 1,
    };
    await expect(
      journal.finish({ ...proof, interactionId: "next" }, op.id, 0, {
        status: "success",
      }),
    ).rejects.toThrow();
    await journal.finish(proof, op.id, 0, {
      status: "success",
      issueId: "fixture-issue",
    });
    expect((await journal.lookup(b, op.id)).results).toEqual([
      { status: "success", issueId: "fixture-issue" },
    ]);
    await expect(
      journal.lookup({ ...b, interactionId: "next" }, op.id),
    ).rejects.toThrow();
    await expect(
      journal.finish(proof, op.id, 0, { status: "dispatched" }),
    ).rejects.toThrow();
  });
});
