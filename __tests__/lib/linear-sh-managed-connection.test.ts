import { NextRequest } from "next/server";
jest.mock("@/lib/db", () => ({
  prisma: { botMcpServer: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock("@/lib/auth-session", () => ({
  getSessionUser: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/super-admin", () => ({ isSuperAdmin: jest.fn() }));
import { prisma } from "@/lib/db";
import { encryptApiKey } from "@/lib/encryption";
import { POST } from "@/app/api/bots/[id]/mcp-servers/[serverId]/test/route";

it("never sends managed client credentials as a static bearer token through the generic test button", async () => {
  const previous = { ...process.env };
  process.env.ADMIN_API_TOKEN = "fixture-admin";
  process.env.ENCRYPTION_KEY = "ef".repeat(32);
  const http = jest
    .spyOn(global, "fetch")
    .mockRejectedValue(new Error("Network forbidden"));
  try {
    jest.mocked(prisma.botMcpServer.findUnique).mockResolvedValue({
      id: "connection",
      botId: "bot",
      serverUrl: "https://mcp.linear.app/mcp",
      authType: "bearer",
      authConfig: encryptApiKey(
        JSON.stringify({
          linearSh: { clientId: "fixture", clientSecret: "fictional-secret" },
        }),
      ),
    } as never);
    jest.mocked(prisma.botMcpServer.update).mockResolvedValue({} as never);
    const response = await POST(
      new NextRequest(
        "http://localhost/api/bots/bot/mcp-servers/connection/test",
        {
          method: "POST",
          headers: { authorization: "Bearer fixture-admin" },
        },
      ),
      { params: Promise.resolve({ id: "bot", serverId: "connection" }) },
    );
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain("fictional-secret");
    expect(http).not.toHaveBeenCalled();
  } finally {
    http.mockRestore();
    process.env = previous;
  }
});
