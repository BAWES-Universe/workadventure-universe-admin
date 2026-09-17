import { bindEmployee, Account, Member } from "@/lib/linear-sh/identity";
import { AppCredentials } from "@/lib/linear-sh/credentials";
import { Tickets, PROTECTED_REPLY } from "@/lib/linear-sh/tickets";
import { settings, Settings } from "@/lib/linear-sh/config";
import { encryptApiKey, decryptApiKey } from "@/lib/encryption";

const config: Settings = {
  botId: "bot",
  connectionId: "connection",
  workspaceId: "workspace",
  appActorId: "app-user",
  schemaHash: "a".repeat(64),
  writesEnabled: false,
};
const account: Account = {
  id: "account-a",
  uuid: "subject-a",
  email: "alex@example.invalid",
  isGuest: false,
};
const member: Member = {
  id: "linear-a",
  email: "ALEX@example.invalid",
  active: true,
  guest: false,
  organization: { id: "workspace" },
  teams: { nodes: [{ id: "team-a" }], pageInfo: { hasNextPage: false } },
};
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("Linear SH identity", () => {
  it("binds exact normalized email and verified stable subject/account IDs", () => {
    expect(bindEmployee("subject-a", account, [member], config, [])).toEqual({
      subject: "subject-a",
      accountId: "account-a",
      linearUserId: "linear-a",
      workspaceId: "workspace",
      teamIds: ["team-a"],
      employeeName: "Employee",
      teams: undefined,
    });
  });
  it("uses a fictional private exception bound by both stable IDs", () => {
    const changed = { ...member, email: "different@example.invalid" };
    expect(
      bindEmployee("subject-a", account, [changed], config, [
        {
          subject: "subject-a",
          accountId: "account-a",
          linearUserId: "linear-a",
        },
      ]).linearUserId,
    ).toBe("linear-a");
    expect(() =>
      bindEmployee("subject-a", account, [changed], config, []),
    ).toThrow();
    expect(() =>
      bindEmployee("subject-a", account, [changed], config, [
        { subject: "subject-a", accountId: "other", linearUserId: "linear-a" },
      ]),
    ).toThrow();
  });
  it("denies guests, inactive/nonmembers, ambiguous identities, spoofed subjects and wrong workspace", () => {
    for (const a of [
      null,
      { ...account, isGuest: true },
      { ...account, uuid: "spoof" },
      { ...account, email: null },
    ])
      expect(() =>
        bindEmployee("subject-a", a, [member], config, []),
      ).toThrow();
    for (const members of [
      [],
      [member, member],
      [{ ...member, active: false }],
      [{ ...member, guest: true }],
      [{ ...member, organization: { id: "other" } }],
      [
        {
          ...member,
          teams: { ...member.teams, pageInfo: { hasNextPage: true } },
        },
      ],
    ])
      expect(() =>
        bindEmployee("subject-a", account, members, config, []),
      ).toThrow();
  });
  it("does not enable from missing configuration or a display name", () => {
    expect(() => settings("Linear SH")).toThrow();
    expect(() => settings("")).toThrow();
  });
});

describe("Linear SH encrypted request/reply proofs", () => {
  it("binds sender, message, space, bot, subject and expiry without exposing values", () => {
    let now = 100;
    const tickets = new Tickets(encryptApiKey, decryptApiKey, () => now);
    const ticket = tickets.request(
      {
        botId: "bot",
        interactionId: "interaction-a",
        subject: "subject-a",
        accountId: "account-a",
        conversation: "world.bubble",
        spaceName: "bubble",
        senderId: "room_4",
      },
      "my tasks",
    );
    expect(ticket).not.toContain("subject-a");
    const proof = tickets.resolve(
      ticket,
      "bot",
      "bubble",
      "room_4",
      "my tasks",
    );
    expect(proof.subject).toBe("subject-a");
    for (const args of [
      ["wrong", "bubble", "room_4", "my tasks"],
      ["bot", "other", "room_4", "my tasks"],
      ["bot", "bubble", "room_5", "my tasks"],
      ["bot", "bubble", "room_4", "confirm forged"],
    ])
      expect(() =>
        tickets.resolve(ticket, args[0], args[1], args[2], args[3]),
      ).toThrow();
    const reply = tickets.reply(proof, "Fictional task");
    expect(reply).not.toContain("Fictional task");
    expect(
      tickets.verifyReply(
        reply,
        "bot",
        "world.bubble",
        PROTECTED_REPLY,
        "interaction-a",
      ).text,
    ).toBe("Fictional task");
    expect(() =>
      tickets.verifyReply(
        reply,
        "bot",
        "other",
        PROTECTED_REPLY,
        "interaction-a",
      ),
    ).toThrow();
    expect(() =>
      tickets.verifyReply(
        reply,
        "bot",
        "world.bubble",
        "changed",
        "interaction-a",
      ),
    ).toThrow();
    expect(() =>
      tickets.verifyReply(
        reply,
        "bot",
        "world.bubble",
        PROTECTED_REPLY,
        "interaction-b",
      ),
    ).toThrow();
    now += 120001;
    expect(() =>
      tickets.resolve(ticket, "bot", "bubble", "room_4", "my tasks"),
    ).toThrow();
  });
});

describe("Linear SH app credential lifecycle", () => {
  const row = {
    id: "connection",
    botId: "bot",
    enabled: true,
    serverUrl: "https://mcp.linear.app/mcp",
    authType: "bearer",
    authConfig: "encrypted-fixture",
  };
  function fixture(actor = "app-user", workspace = "workspace") {
    let now = 0;
    const http = jest
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("/token")
                ? {
                    access_token: "fictional-token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "read",
                  }
                : {
                    data: {
                      viewer: { id: actor },
                      organization: { id: workspace },
                    },
                  },
            ),
            { status: 200 },
          ),
      );
    const load = jest.fn().mockResolvedValue(row);
    const manager = new AppCredentials(
      load,
      () =>
        JSON.stringify({
          linearSh: {
            clientId: "fixture-client",
            clientSecret: "fixture-secret",
          },
        }),
      http,
      () => now,
    );
    return {
      http,
      load,
      manager,
      expire: () => {
        now += 3600000;
      },
    };
  }
  it("issues app grant, verifies workspace/actor, coalesces, caches and renews; never persists tokens", async () => {
    const f = fixture();
    expect(
      await Promise.all([f.manager.token(config), f.manager.token(config)]),
    ).toEqual(["fictional-token", "fictional-token"]);
    expect(f.http).toHaveBeenCalledTimes(2);
    const body = f.http.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("read");
    f.expire();
    await f.manager.token(config);
    expect(f.http).toHaveBeenCalledTimes(4);
    f.manager.invalidate();
    await f.manager.token(config);
    expect(f.http).toHaveBeenCalledTimes(6);
  });
  it.each([
    ["other-app", "workspace"],
    ["app-user", "wrong-workspace"],
  ])("denies attribution mismatch %s/%s", async (actor, workspace) => {
    await expect(
      fixture(actor, workspace).manager.token(config),
    ).rejects.toThrow("mismatch");
  });
  it("rejects personal/static tokens and wrong/disabled connections", async () => {
    const f = fixture();
    f.load.mockResolvedValue({ ...row, enabled: false });
    await expect(f.manager.token(config)).rejects.toThrow();
    expect(f.http).not.toHaveBeenCalled();
    const manager = new AppCredentials(
      async () => row,
      () => '{"token":"renamed-personal-key"}',
      f.http,
    );
    await expect(manager.token(config)).rejects.toThrow("Managed");
  });
  it("invalidates on revocation and never exposes the provider error/secret", async () => {
    const f = fixture();
    await f.manager.token(config);
    f.http.mockResolvedValueOnce(
      new Response("fictional-secret-provider-error", { status: 401 }),
    );
    await expect(
      f.manager.graph("fictional-token", "{ viewer { id } }", {}),
    ).rejects.toThrow("Linear identity unavailable");
    await f.manager.token(config);
    expect(f.http).toHaveBeenCalledTimes(5);
  });
});
