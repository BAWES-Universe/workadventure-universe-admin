-- Per-bot rules (#427): who may use one bot, beyond what their roles allow.
--
-- Nobody gains or loses anything: a bot gets Private bot off, no fixed reply and no rule rows, so every check answers
-- exactly as it did (the roles decide). Existing bots all start with the same daily cap per person, 50; nothing reads it
-- until the reply limits (#1159).

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "daily_reply_cap" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "private_bot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refusal_reply" VARCHAR(500);

-- CreateTable
CREATE TABLE "bot_access_rules" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "role_id" TEXT,
    "user_id" TEXT,
    "allow" BIGINT NOT NULL DEFAULT 0,
    "deny" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_access_rules_role_id_idx" ON "bot_access_rules"("role_id");

-- CreateIndex
CREATE INDEX "bot_access_rules_user_id_idx" ON "bot_access_rules"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_access_rules_bot_id_role_id_key" ON "bot_access_rules"("bot_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_access_rules_bot_id_user_id_key" ON "bot_access_rules"("bot_id", "user_id");

-- AddForeignKey
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A row is for a role or for a person, never both and never neither. The numbers hold only the four bot bits (Manage
-- bots 8192, Chat nearby 16384, DM 32768, Summon 65536 = 122880), and a bit is never both Yes and No.
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_one_subject" CHECK (("role_id" IS NULL) <> ("user_id" IS NULL));
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_bits" CHECK (
    "allow" >= 0 AND "deny" >= 0 AND ("allow" & ~122880) = 0 AND ("deny" & ~122880) = 0 AND ("allow" & "deny") = 0
);
-- The daily cap is a whole number of replies, at least one
ALTER TABLE "bots" ADD CONSTRAINT "bots_daily_reply_cap_range" CHECK ("daily_reply_cap" BETWEEN 1 AND 10000);
