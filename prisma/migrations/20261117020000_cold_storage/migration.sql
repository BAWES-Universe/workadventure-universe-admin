-- Cold storage for Brick computers: after idle days (a Limit, `bricks.coldStorageDays`, 14 until a super admin changes it) a computer is packed into our
-- own encrypted, versioned storage, restored once on a throwaway computer to prove the copy, and only then deleted. Nothing existing changes.

ALTER TABLE "brick_computers"
  ADD COLUMN "packed_at" TIMESTAMP(3),
  ADD COLUMN "pack_claimed_at" TIMESTAMP(3),
  ADD COLUMN "pack_stage" VARCHAR(10),
  ADD COLUMN "pack_archive_id" VARCHAR(40),
  ADD COLUMN "pack_previous" VARCHAR(10),
  ADD COLUMN "pack_tried_at" TIMESTAMP(3),
  ADD COLUMN "pack_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "returned_at" TIMESTAMP(3),
  ADD COLUMN "return_ms" INTEGER,
  ADD COLUMN "older_copy_used" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "computer_archives" (
  "id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "state" VARCHAR(10) NOT NULL,
  "object_key" VARCHAR(255) NOT NULL,
  "bytes" BIGINT NOT NULL DEFAULT 0,
  "sha256" VARCHAR(64),
  "manifest" JSONB,
  "key_version" INTEGER NOT NULL DEFAULT 1,
  "image_revision" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" TIMESTAMP(3),
  "proof_ms" INTEGER,
  "failure" VARCHAR(200),
  CONSTRAINT "computer_archives_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "computer_archives_bot_id_generation_key" ON "computer_archives"("bot_id", "generation");
CREATE INDEX "computer_archives_bot_id_state_idx" ON "computer_archives"("bot_id", "state");
CREATE INDEX "computer_archives_state_created_at_idx" ON "computer_archives"("state", "created_at");

CREATE TABLE "computer_cold_runs" (
  "id" TEXT NOT NULL,
  "kind" VARCHAR(8) NOT NULL,
  "bot_id" TEXT,
  "machine_ref" VARCHAR(255),
  "scratch" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  "seconds" INTEGER NOT NULL DEFAULT 0,
  "outcome" VARCHAR(8) NOT NULL DEFAULT 'open',
  "detail" VARCHAR(200),
  CONSTRAINT "computer_cold_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "computer_cold_runs_bot_id_started_at_idx" ON "computer_cold_runs"("bot_id", "started_at");
CREATE INDEX "computer_cold_runs_kind_started_at_idx" ON "computer_cold_runs"("kind", "started_at");
