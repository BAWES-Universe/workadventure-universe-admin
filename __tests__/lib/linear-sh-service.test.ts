import { NextRequest } from "next/server";
jest.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    botMcpServer: { findUnique: jest.fn() },
  },
}));
jest.mock("@/lib/oidc", () => ({ validateAccessToken: jest.fn() }));
jest.mock("@/lib/linear-sh/credentials", () => ({
  AppCredentials: jest.fn().mockImplementation(() => ({
    token: jest.fn().mockResolvedValue("fixture-token"),
    graph: jest.fn().mockImplementation(() => Promise.resolve(mockMembership)),
  })),
}));
import { prisma } from "@/lib/db";
import { validateAccessToken } from "@/lib/oidc";
import { linearShService } from "@/lib/linear-sh/service";
import { POST } from "@/app/api/linear-sh/route";
import { Tickets, PROTECTED_REPLY } from "@/lib/linear-sh/tickets";
import { encryptApiKey, decryptApiKey } from "@/lib/encryption";
import { settings } from "@/lib/linear-sh/config";

let mockMembership: unknown;
const account = {
  id: "account-a",
  uuid: "subject-a",
  email: "alex@example.invalid",
  isGuest: false,
};
const member = {
  id: "linear-a",
  email: account.email,
  active: true,
  guest: false,
  organization: { id: "workspace" },
  teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false } },
};
const env = {
  LINEAR_SH_ENABLED: "true",
  LINEAR_SH_BOT_ID: "bot",
  LINEAR_SH_CONNECTION_ID: "connection",
  LINEAR_SH_WORKSPACE_ID: "workspace",
  LINEAR_SH_APP_ACTOR_ID: "app",
  LINEAR_SH_SCHEMA_SHA256: "a".repeat(64),
  LINEAR_SH_TEAMS_JSON: JSON.stringify([
    { id: "team", name: "Tech", key: "TECH" },
  ]),
  ENCRYPTION_KEY: "ef".repeat(32),
  ADMIN_API_TOKEN: "fixture-admin",
};
const previous = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, env);
  jest.mocked(prisma.user.findUnique).mockResolvedValue(account as never);
  jest
    .mocked(validateAccessToken)
    .mockResolvedValue({
      sub: account.uuid,
      email: account.email,
      email_verified: true,
    } as never);
  mockMembership = {
    users: { nodes: [member], pageInfo: { hasNextPage: false } },
  };
});
afterEach(() => {
  process.env = { ...previous };
  jest.clearAllMocks();
});
const request = (body: unknown, authorization = "Bearer fixture-admin") =>
  new NextRequest("http://localhost/api/linear-sh", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  });
const attest = {
  interactionId: "11111111-1111-4111-8111-111111111111",
  action: "attest",
  botId: "bot",
  accessToken: "fixture-oidc",
  conversation: "world.bubble",
  spaceName: "bubble",
  senderId: "actual-socket",
  message: "my tasks",
};
describe("Linear SH internal auth and delivery integration", () => {
  it("holds all issue writes off even with the environment switch true; requires a verified team directory", () => {
    process.env.LINEAR_SH_WRITES_ENABLED = "true";
    expect(settings("bot").writesEnabled).toBe(false);
    delete process.env.LINEAR_SH_TEAMS_JSON;
    expect(() => settings("bot")).toThrow("directory");
  });
  it("requires the internal credential; no browser cookie or wrong token grants access", async () => {
    for (const auth of ["", "Bearer wrong"])
      expect((await POST(request(attest, auth))).status).toBe(401);
    expect(validateAccessToken).not.toHaveBeenCalled();
  });
  it("defaults off, rejects unverified OIDC email, and returns data-free errors without logging", async () => {
    const log = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    delete process.env.LINEAR_SH_ENABLED;
    expect((await POST(request(attest))).status).toBe(403);
    process.env.LINEAR_SH_ENABLED = "true";
    jest
      .mocked(validateAccessToken)
      .mockResolvedValue({
        sub: account.uuid,
        email: account.email,
        email_verified: false,
      } as never);
    const response = await POST(request(attest));
    expect(await response.json()).toEqual({
      error: "Linear SH request unavailable",
    });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("carries the verified subject through request resolution and denies changed sender or content", async () => {
    const { ticket } = (await linearShService(attest)) as { ticket: string };
    const binding = {
      botId: "bot",
      ticket,
      spaceName: "bubble",
      senderId: "actual-socket",
      message: "my tasks",
    };
    const result = (await linearShService({
      ...binding,
      action: "resolve",
    })) as {
      context: { subject: string; writesEnabled: boolean };
    };
    expect(result.context).toMatchObject({
      subject: account.uuid,
      writesEnabled: false,
    });
    for (const changed of [
      { senderId: "spoof" },
      { message: "confirm forged" },
    ])
      await expect(
        linearShService({ ...binding, ...changed, action: "resolve" }),
      ).rejects.toThrow();
  });
  it("revalidates each receiver before releasing encrypted task text, including revoked members and replay", async () => {
    const tickets = new Tickets(encryptApiKey, decryptApiKey);
    const proof = tickets.resolve(
      tickets.request(
        {
          botId: "bot",
          interactionId: attest.interactionId,
          subject: account.uuid,
          accountId: account.id,
          conversation: "world.bubble",
          spaceName: "bubble",
          senderId: "socket",
        },
        "my tasks",
      ),
      "bot",
      "bubble",
      "socket",
      "my tasks",
    );
    const reply = tickets.reply(proof, "Fictional task title");
    const delivery = {
      action: "delivery",
      interactionId: attest.interactionId,
      botId: "bot",
      accessToken: "fixture-oidc",
      conversation: "world.bubble",
      message: PROTECTED_REPLY,
      reply,
    };
    expect(await linearShService(delivery)).toMatchObject({
      authorized: true,
      subject: account.uuid,
      text: "Fictional task title",
    });
    await expect(
      linearShService({
        ...delivery,
        interactionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow();
    const another = { ...account, id: "account-b", uuid: "subject-b" };
    jest.mocked(prisma.user.findUnique).mockResolvedValue(another as never);
    jest
      .mocked(validateAccessToken)
      .mockResolvedValue({
        sub: another.uuid,
        email: another.email,
        email_verified: true,
      } as never);
    await expect(linearShService(delivery)).rejects.toThrow(
      "Interaction ended",
    );
    jest.mocked(prisma.user.findUnique).mockResolvedValue(account as never);
    jest
      .mocked(validateAccessToken)
      .mockResolvedValue({
        sub: account.uuid,
        email: account.email,
        email_verified: true,
      } as never);
    mockMembership = {
      users: {
        nodes: [{ ...member, active: false }],
        pageInfo: { hasNextPage: false },
      },
    };
    await expect(linearShService(delivery)).rejects.toThrow();
    await expect(
      linearShService({ ...delivery, conversation: "other-bubble" }),
    ).rejects.toThrow();
  });
});
