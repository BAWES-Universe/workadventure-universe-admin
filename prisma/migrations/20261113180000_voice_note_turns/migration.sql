-- Voice notes for every bot: a turn record per voice note (reserved once, each paid stage run once, a lost answer kept
-- encrypted for 15 minutes) and the provider files and transcriptions still to delete. Nothing is written by this migration.

-- CreateTable
CREATE TABLE "voice_note_turns" (
    "id" TEXT NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "person_key" VARCHAR(300) NOT NULL,
    "target" VARCHAR(300) NOT NULL,
    "bot_id" VARCHAR(64),
    "universe_key" VARCHAR(64),
    "client_turn_id" VARCHAR(255) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "payer" VARCHAR(16) NOT NULL,
    "provider_id" VARCHAR(64),
    "seconds" INTEGER NOT NULL,
    "heard_seconds" INTEGER,
    "state" VARCHAR(16) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "provider_refs" JSONB,
    "released" BOOLEAN NOT NULL DEFAULT false,
    "cost_micros" INTEGER,
    "buffer" TEXT,
    "buffer_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_note_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_note_cleanups" (
    "id" TEXT NOT NULL,
    "provider_id" VARCHAR(64) NOT NULL,
    "region" VARCHAR(50),
    "kind" VARCHAR(16) NOT NULL,
    "object_id" VARCHAR(255) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "last_status" INTEGER,
    "overdue" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "voice_note_cleanups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_note_turns_person_key_created_at_idx" ON "voice_note_turns"("person_key", "created_at");

-- CreateIndex
CREATE INDEX "voice_note_turns_target_created_at_idx" ON "voice_note_turns"("target", "created_at");

-- CreateIndex
CREATE INDEX "voice_note_turns_universe_key_created_at_idx" ON "voice_note_turns"("universe_key", "created_at");

-- CreateIndex
CREATE INDEX "voice_note_turns_payer_created_at_idx" ON "voice_note_turns"("payer", "created_at");

-- CreateIndex
CREATE INDEX "voice_note_turns_buffer_until_idx" ON "voice_note_turns"("buffer_until");

-- CreateIndex
CREATE UNIQUE INDEX "voice_note_turns_scope_person_key_target_client_turn_id_key" ON "voice_note_turns"("scope", "person_key", "target", "client_turn_id");

-- CreateIndex
CREATE INDEX "voice_note_cleanups_state_next_at_idx" ON "voice_note_cleanups"("state", "next_at");

-- CreateIndex
CREATE UNIQUE INDEX "voice_note_cleanups_provider_id_kind_object_id_key" ON "voice_note_cleanups"("provider_id", "kind", "object_id");

