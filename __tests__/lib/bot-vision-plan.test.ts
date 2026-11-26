import { visionPlan } from "@/lib/bot-ai-credentials";

jest.mock("@/lib/db", () => ({
  prisma: {
    bot: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    botsAiProvider: { findUnique: jest.fn() },
    aiKeyLend: { findUnique: jest.fn() },
  },
}));

import { prisma } from "@/lib/db";

const db = prisma as unknown as {
  botsAiProvider: { findUnique: jest.Mock };
  aiKeyLend: { findUnique: jest.Mock };
};

const brick = (vision?: unknown) =>
  ({
    id: "brick",
    createdById: "owner",
    roomId: null,
    ownerId: "owner",
    deletedAt: null,
    behaviorConfig: vision ? { vision } : null,
    room: null,
  }) as never;
const ownKey = (extra: Record<string, unknown> = {}) =>
  ({
    source: "own-key",
    providerId: "key-1",
    model: "text-model",
    supportsVision: false,
    keyOwnerId: "owner",
    keyGroup: "hosted",
    ...extra,
  }) as never;

beforeEach(() => jest.resetAllMocks());

describe("the Vision plan served to someone who is not the Brick’s owner (game #2005)", () => {
  it("says nobody looks when the owner picked another model: the owner’s key is not theirs, and Universe AI or the model that answers is not what the owner picked", async () => {
    const plan = await visionPlan(
      brick({ choice: "another", keyId: "key-2", model: "v" }),
      ownKey(),
      { universeId: "universe-1" },
    );
    expect(plan).toEqual({ choice: "this", problem: "key" });
  });

  it("leaves the other picks as they were", async () => {
    expect(
      await visionPlan(brick({ choice: "universe-ai" }), ownKey(), {
        universeId: "universe-1",
      }),
    ).toEqual({ choice: "universe-ai" });
    expect(
      await visionPlan(brick({ choice: "this" }), ownKey(), {
        universeId: "universe-1",
      }),
    ).toEqual({ choice: "this" });
  });
});

describe("the default Vision plan for a Brick on a person’s own key with nothing picked", () => {
  beforeEach(() => {
    db.aiKeyLend.findUnique.mockResolvedValue(null);
    // The key's own check model does not see and the provider names no other model with Vision
    db.botsAiProvider.findUnique.mockResolvedValue({
      model: "text-model",
      supportsVision: false,
      settings: { kind: "lmstudio" },
    });
  });

  it("goes to Universe AI for a key on the provider’s own address, as shown on the page", async () => {
    expect(await visionPlan(brick(), ownKey({ keyGroup: "hosted" }))).toEqual({
      choice: "universe-ai",
    });
  });

  it("says nothing (This model) for a key on the person’s own computer: its images never leave it for Universe AI", async () => {
    expect(
      await visionPlan(brick(), ownKey({ keyGroup: "own-computer" })),
    ).toBeUndefined();
  });

  it("still goes to Universe AI when the owner picked it on a key on their own computer", async () => {
    expect(
      await visionPlan(
        brick({ choice: "universe-ai" }),
        ownKey({ keyGroup: "own-computer" }),
      ),
    ).toEqual({ choice: "universe-ai" });
  });
});
