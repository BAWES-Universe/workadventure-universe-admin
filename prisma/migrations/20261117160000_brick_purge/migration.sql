-- Final purge of a deleted Brick (audit F08): what is left to delete OUTSIDE Orbit (the machine at its provider, the saved files in our
-- bucket) is written in the same transaction that deletes the Brick, so a failed outside deletion is tried again by the sweep after the
-- Brick's own rows are gone. No content, no name: only where the machine is and what is still to do. No foreign key on purpose.
CREATE TABLE "brick_purges" (
    "bot_id" VARCHAR(255) NOT NULL,
    "owner_id" TEXT,
    "provider" VARCHAR(10),
    "provider_ref" VARCHAR(255),
    "machine_pending" BOOLEAN NOT NULL DEFAULT false,
    "copy_pending" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_try_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_tried_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "brick_purges_pkey" PRIMARY KEY ("bot_id")
);

CREATE INDEX "brick_purges_done_at_next_try_at_idx" ON "brick_purges"("done_at", "next_try_at");
