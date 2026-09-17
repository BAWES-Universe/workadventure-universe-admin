import { prisma } from "@/lib/db";
import { encryptApiKey, decryptApiKey } from "@/lib/encryption";
import { validateAccessToken } from "@/lib/oidc";
import { settings, Settings } from "./config";
import { AppCredentials } from "./credentials";
import { bindEmployee, Override, Member } from "./identity";
import { z } from "zod";
import { Tickets } from "./tickets";
import { Journal } from "./journal";

const credentials = new AppCredentials(
  (id) => prisma.botMcpServer.findUnique({ where: { id } }),
  decryptApiKey,
);
const tickets = new Tickets(encryptApiKey, decryptApiKey);
const journal = new Journal(prisma, encryptApiKey, decryptApiKey);
const text = z.string().min(1).max(16000);
const base = { botId: text };
const binding = {
  ...base,
  ticket: text,
  spaceName: text,
  senderId: text,
  message: text,
};
const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("attest"),
      interactionId: z.string().uuid(),
      accessToken: text,
      conversation: text,
      spaceName: text,
      senderId: text,
      message: text,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("delivery"),
      interactionId: z.string().uuid(),
      accessToken: text,
      conversation: text,
      message: text,
      reply: z.string().min(1).max(150000),
    })
    .strict(),
  ...(["resolve", "invalidate"] as const).map((action) =>
    z.object({ ...binding, action: z.literal(action) }).strict(),
  ),
  z
    .object({
      ...binding,
      action: z.literal("seal"),
      text: z.string().max(24000),
    })
    .strict(),
  z
    .object({ ...binding, action: z.literal("prepare"), items: z.unknown() })
    .strict(),
  ...(["lookup", "cancel"] as const).map((action) =>
    z
      .object({ ...binding, action: z.literal(action), id: z.string().uuid() })
      .strict(),
  ),
  z
    .object({
      ...binding,
      action: z.literal("claim"),
      id: z.string().uuid(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      ...binding,
      action: z.literal("record"),
      id: z.string().uuid(),
      index: z.number().int().min(0).max(9),
      outcome: z
        .object({
          status: z.enum(["dispatched", "success", "unknown", "skipped"]),
          issueId: text.optional(),
        })
        .strict(),
    })
    .strict(),
]);
type MembershipResult = {
  user?: Member;
  users?: { nodes: Member[]; pageInfo: { hasNextPage: boolean } };
};

async function employee(subject: string, config: Settings) {
  const account = await prisma.user.findUnique({ where: { uuid: subject } });
  if (!account?.email || account.isGuest)
    throw new Error("Employee unavailable");
  const overrides: Override[] = process.env
    .LINEAR_SH_IDENTITY_OVERRIDES_ENCRYPTED
    ? JSON.parse(
        decryptApiKey(process.env.LINEAR_SH_IDENTITY_OVERRIDES_ENCRYPTED),
      )
    : [];
  if (
    !Array.isArray(overrides) ||
    overrides.some((v) => !v.subject || !v.accountId || !v.linearUserId)
  )
    throw new Error("Invalid private identity configuration");
  const exception = overrides.find((v) => v.subject === subject);
  const token = await credentials.token(config);
  const fragment =
    "id name email active guest organization { id } teams(first: 100) { nodes { id } pageInfo { hasNextPage } }";
  const result = exception
    ? await credentials.graph<MembershipResult>(
        token,
        `query($id: String!) { user(id: $id) { ${fragment} } }`,
        {
          id: exception.linearUserId,
        },
      )
    : await credentials.graph<MembershipResult>(
        token,
        `query($email: String!) { users(first: 2, includeDisabled: true, filter: {email: {eqIgnoreCase: $email}}) { nodes { ${fragment} } pageInfo { hasNextPage } } }`,
        { email: account.email.trim() },
      );
  if (!exception && result.users?.pageInfo?.hasNextPage !== false)
    throw new Error("Ambiguous membership");
  const members = exception
    ? result.user
      ? [result.user]
      : []
    : result.users?.nodes;
  if (!Array.isArray(members)) throw new Error("Membership unavailable");
  return {
    actor: bindEmployee(subject, account, members, config, overrides),
    token,
  };
}
async function authenticated(accessToken: string, config: Settings) {
  if (typeof accessToken !== "string" || !accessToken)
    throw new Error("Authentication required");
  const info = await validateAccessToken(accessToken, true);
  if (
    !info ||
    typeof info.sub !== "string" ||
    !info.sub ||
    typeof info.email !== "string" ||
    info.email_verified !== true
  )
    throw new Error("Verified identity required");
  const account = await prisma.user.findUnique({ where: { uuid: info.sub } });
  if (
    !account?.email ||
    account.email.trim().toLowerCase() !== info.email.trim().toLowerCase()
  )
    throw new Error("Account identity mismatch");
  return (await employee(info.sub, config)).actor;
}

/** Internal ADMIN_API_TOKEN-only service. Errors returned to callers are deliberately data-free. */
export async function linearShService(raw: unknown): Promise<unknown> {
  const input = inputSchema.parse(raw);
  if (input.action === "record" && input.outcome.status !== "dispatched") {
    const proof = tickets.resolve(
      input.ticket,
      input.botId,
      input.spaceName,
      input.senderId,
      input.message,
      true,
    );
    return journal.finish(proof, input.id, input.index, input.outcome);
  }
  const config = settings(input.botId);
  if (input.action === "attest") {
    const actor = await authenticated(input.accessToken, config);
    if (
      ![
        input.conversation,
        input.spaceName,
        input.senderId,
        input.message,
      ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 16000)
    )
      throw new Error("Invalid request");
    return {
      ticket: tickets.request(
        {
          botId: config.botId,
          subject: actor.subject,
          accountId: actor.accountId,
          conversation: input.conversation,
          spaceName: input.spaceName,
          senderId: input.senderId,
          interactionId: input.interactionId,
        },
        input.message,
      ),
    };
  }
  if (input.action === "delivery") {
    const reply = tickets.verifyReply(
      input.reply,
      config.botId,
      input.conversation,
      input.message,
      input.interactionId,
    );
    const actor = await authenticated(input.accessToken, config);
    if (actor.subject !== reply.subject || actor.accountId !== reply.accountId)
      throw new Error("Interaction ended");
    return {
      authorized: true,
      subject: actor.subject,
      text: reply.text,
      requestId: reply.requestId,
    };
  }
  const proof = tickets.resolve(
    input.ticket,
    config.botId,
    input.spaceName,
    input.senderId,
    input.message,
  );
  const { actor, token } = await employee(proof.subject, config);
  if (actor.accountId !== proof.accountId) throw new Error("Account changed");
  const context = {
    ...actor,
    ...config,
    conversation: proof.conversation,
    requestId: proof.requestId,
    interactionId: proof.interactionId,
    expiresAt: proof.expiresAt,
  };
  switch (input.action) {
    case "resolve":
      return { context, token };
    case "seal":
      if (typeof input.text !== "string" || input.text.length > 24000)
        throw new Error("Invalid reply");
      return { reply: tickets.reply(proof, input.text) };
    case "prepare":
      return journal.prepare(context, input.items);
    case "lookup":
      return journal.lookup(context, input.id);
    case "claim":
      return journal.claim(context, input.id, input.hash);
    case "record":
      return journal.record(context, input.id, input.index, input.outcome);
    case "cancel":
      return journal.cancel(context, input.id);
    case "invalidate":
      credentials.invalidate();
      return { invalidated: true };
    default:
      throw new Error("Unsupported request");
  }
}
