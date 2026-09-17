import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, LinearShOperation } from "@prisma/client";
import { Settings } from "./config";
import { Employee } from "./identity";
import type { RequestProof } from "./tickets";

const text = z.string().min(1).max(300);
const fields = {
  title: text.optional(),
  description: z.string().max(10000).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  state: text.optional(),
};
const itemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      args: z
        .object({ ...fields, title: text, team: text, assignee: text })
        .strict(),
      stateName: text.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      expectedUpdatedAt: text,
      teamId: text,
      args: z.object({ ...fields, id: text }).strict(),
      stateName: text.optional(),
    })
    .strict(),
]);
const payloadSchema = z.array(itemSchema).min(1).max(10);
export type Item = z.infer<typeof itemSchema>;
export type Binding = Employee &
  Settings & { conversation: string; requestId: string; interactionId: string };
export type Outcome = {
  status: "not_dispatched" | "dispatched" | "success" | "unknown" | "skipped";
  issueId?: string;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export const payloadHash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");

export class Journal {
  constructor(
    private db: PrismaClient,
    private encrypt: (s: string) => string,
    private decrypt: (s: string) => string,
    private now = Date.now,
  ) {}
  private where(b: Binding) {
    return {
      botId: b.botId,
      connectionId: b.connectionId,
      workspaceId: b.workspaceId,
      appActorId: b.appActorId,
      subject: b.subject,
      accountId: b.accountId,
      linearUserId: b.linearUserId,
      conversation: b.conversation,
      interactionId: b.interactionId,
    };
  }
  private view(row: LinearShOperation) {
    return {
      id: row.id,
      hash: row.payloadHash,
      items: JSON.parse(this.decrypt(row.payload)),
      status: row.status,
      results: row.results,
      expiresAt: row.expiresAt.getTime(),
    };
  }
  async prepare(b: Binding, input: unknown) {
    if (!b.writesEnabled) throw new Error("Writes disabled");
    const items = payloadSchema.parse(input);
    for (const item of items) {
      const team = item.kind === "create" ? item.args.team : item.teamId;
      if (
        !b.teamIds.includes(team) ||
        (item.kind === "create" && item.args.assignee !== b.linearUserId)
      )
        throw new Error("Write scope mismatch");
      if (
        item.args.dueDate &&
        (isNaN(Date.parse(item.args.dueDate)) ||
          new Date(item.args.dueDate).toISOString().slice(0, 10) !==
            item.args.dueDate)
      )
        throw new Error("Invalid date");
      if (item.kind === "edit" && Object.keys(item.args).length < 2)
        throw new Error("No changes");
    }
    const hash = payloadHash(items);
    const requestKey = payloadHash({
      ...this.where(b),
      requestId: b.requestId,
    });
    return this.db.$transaction(async (tx) => {
      // Serialize pending previews for the same requester/conversation across replicas.
      const lock = payloadHash({
        botId: b.botId,
        subject: b.subject,
        conversation: b.conversation,
      });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))`;
      const old = await tx.linearShOperation.findUnique({
        where: { requestKey },
      });
      if (old) {
        if (old.payloadHash !== hash)
          throw new Error("Request content changed");
        return this.view(old);
      }
      await tx.linearShOperation.updateMany({
        where: { ...this.where(b), status: "pending" },
        data: { status: "superseded" },
      });
      return this.view(
        await tx.linearShOperation.create({
          data: {
            id: randomUUID(),
            requestKey,
            ...this.where(b),
            payloadHash: hash,
            payload: this.encrypt(JSON.stringify(items)),
            expiresAt: new Date(this.now() + 5 * 60000),
            results: items.map(() => ({ status: "not_dispatched" })),
          },
        }),
      );
    });
  }
  async lookup(b: Binding, id: string) {
    const row = await this.db.linearShOperation.findFirst({
      where: { ...this.where(b), id },
    });
    if (!row) throw new Error("Confirmation unavailable");
    return this.view(row);
  }
  async claim(b: Binding, id: string, hash: string) {
    if (!b.writesEnabled) throw new Error("Writes disabled");
    // This atomic compare-and-set is the replay boundary. It is NEVER reset after a crash.
    const result = await this.db.linearShOperation.updateMany({
      where: {
        ...this.where(b),
        id,
        payloadHash: hash,
        status: "pending",
        expiresAt: { gt: new Date(this.now()) },
      },
      data: { status: "consumed", consumedAt: new Date(this.now()) },
    });
    return { claimed: result.count === 1, operation: await this.lookup(b, id) };
  }
  async cancel(b: Binding, id: string) {
    await this.db.linearShOperation.updateMany({
      where: { ...this.where(b), id, status: "pending" },
      data: { status: "cancelled" },
    });
    return this.lookup(b, id);
  }
  async record(b: Binding, id: string, index: number, outcome: Outcome) {
    if (
      !Number.isInteger(index) ||
      !["dispatched", "success", "unknown", "skipped"].includes(outcome.status)
    )
      throw new Error("Invalid outcome");
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const row = await tx.linearShOperation.findFirst({
        where: { ...this.where(b), id, status: "consumed" },
      });
      if (!row) throw new Error("Operation not consumed");
      const results = row.results as unknown as Outcome[];
      const previous = results[index]?.status;
      if (!(
        (previous === "not_dispatched" &&
          ["dispatched", "skipped"].includes(outcome.status)) ||
        (previous === "dispatched" &&
          ["success", "unknown", "skipped"].includes(outcome.status))
      ))
        throw new Error("Outcome already recorded");
      results[index] = {
        status: outcome.status,
        ...(outcome.status === "success" && typeof outcome.issueId === "string"
          ? { issueId: outcome.issueId }
          : {}),
      };
      const complete = results.every((r) =>
        ["success", "unknown", "skipped"].includes(r.status),
      );
      await tx.linearShOperation.update({
        where: { id },
        data: { results, status: complete ? "complete" : "consumed" },
      });
      return { recorded: true };
    });
  }
  async finish(
    proof: RequestProof,
    id: string,
    index: number,
    outcome: Outcome,
  ) {
    if (!["success", "unknown", "skipped"].includes(outcome.status))
      throw new Error("Not an outcome");
    const row = await this.db.linearShOperation.findFirst({
      where: {
        id,
        botId: proof.botId,
        subject: proof.subject,
        accountId: proof.accountId,
        conversation: proof.conversation,
        interactionId: proof.interactionId,
        status: "consumed",
      },
    });
    if (!row) throw new Error("Operation unavailable");
    // An expired interaction can record an already-consumed outcome, never prepare/claim/dispatch or return task data.
    return this.record(row as unknown as Binding, id, index, outcome);
  }
}
