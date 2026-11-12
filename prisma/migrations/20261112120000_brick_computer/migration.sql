-- A Brick's computer (game #2000, Brick 9). One lasting computer per Brick; jobs queue on it with at most one WRITING job at a
-- time; every effect a job has outside the computer is written once, before it is tried. Nothing here is per person: there is no
-- switch to allow a computer, every member gives their own Bricks one, inside their allowance (the meter, game #1998). Nothing
-- that exists is touched, and no machine is made until a job needs one.


-- CreateTable
CREATE TABLE "brick_computers" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "machine" VARCHAR(10) NOT NULL DEFAULT 'none',
    "provider" VARCHAR(10) NOT NULL DEFAULT 'fake',
    "provider_ref" VARCHAR(255),
    "made_at" TIMESTAMP(3),
    "last_worked_at" TIMESTAMP(3),
    "files_bytes" BIGINT NOT NULL DEFAULT 0,
    "files_saved_at" TIMESTAMP(3),
    "restored_from" TIMESTAMP(3),
    "rest_claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brick_computers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "computer_jobs" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'queued',
    "queued_for" VARCHAR(10),
    "ended_by" VARCHAR(10),
    "writes" BOOLEAN NOT NULL DEFAULT true,
    "step_done" INTEGER NOT NULL DEFAULT 0,
    "step_total" INTEGER,
    "step_label" VARCHAR(200),
    "waiting_for" VARCHAR(10),
    "ready_what" VARCHAR(150),
    "ready_where" VARCHAR(150),
    "control" VARCHAR(10) NOT NULL DEFAULT 'brick',
    "reservation_key" VARCHAR(255),
    "seconds_run" INTEGER NOT NULL DEFAULT 0,
    "stretch_started" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "last_tried_at" TIMESTAMP(3),

    CONSTRAINT "computer_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "computer_effects" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "effect_key" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'planned',
    "evidence" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "computer_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brick_computers_bot_id_key" ON "brick_computers"("bot_id");

-- CreateIndex
CREATE INDEX "computer_jobs_bot_id_status_idx" ON "computer_jobs"("bot_id", "status");

-- CreateIndex
CREATE INDEX "computer_jobs_person_id_status_idx" ON "computer_jobs"("person_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "computer_effects_job_id_effect_key_key" ON "computer_effects"("job_id", "effect_key");

-- AddForeignKey
ALTER TABLE "brick_computers" ADD CONSTRAINT "brick_computers_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computer_effects" ADD CONSTRAINT "computer_effects_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- The words each column may hold. The code checks them first; the database is the last word.
ALTER TABLE "brick_computers" ADD CONSTRAINT "brick_computers_machine_check" CHECK ("machine" IN ('none', 'waking', 'resting', 'working', 'cold', 'broken', 'restoring', 'stopped'));
ALTER TABLE "brick_computers" ADD CONSTRAINT "brick_computers_provider_check" CHECK ("provider" IN ('fake', 'real'));
ALTER TABLE "brick_computers" ADD CONSTRAINT "brick_computers_files_check" CHECK ("files_bytes" >= 0);

ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'waiting', 'done', 'stopped', 'failed'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_queued_for_check" CHECK ("queued_for" IS NULL OR "queued_for" IN ('turn', 'allowance', 'busy', 'pool'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_ended_by_check" CHECK ("ended_by" IS NULL OR "ended_by" IN ('person', 'allowance', 'pool', 'off', 'deleted', 'error', 'unanswered'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_waiting_for_check" CHECK ("waiting_for" IS NULL OR "waiting_for" IN ('details', 'signin', 'upload', 'pay', 'submit', 'answer'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_control_check" CHECK ("control" IN ('brick', 'person'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_steps_check" CHECK ("step_done" >= 0 AND ("step_total" IS NULL OR "step_total" >= 1) AND "seconds_run" >= 0);
-- A person has the mouse and keyboard only while the job waits for them
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_control_waiting_check" CHECK ("control" = 'brick' OR "status" = 'waiting');

-- One job writing at a time on a Brick's computer: running, or waiting for its person with the machine still theirs. Two jobs
-- started at the same moment cannot both pass this, so the second one queues.
CREATE UNIQUE INDEX "computer_jobs_one_writer" ON "computer_jobs"("bot_id") WHERE "writes" AND "status" IN ('running', 'waiting');

ALTER TABLE "computer_effects" ADD CONSTRAINT "computer_effects_kind_check" CHECK ("kind" IN ('send', 'publish', 'details', 'upload', 'pay', 'submit'));
ALTER TABLE "computer_effects" ADD CONSTRAINT "computer_effects_state_check" CHECK ("state" IN ('approved', 'planned', 'done', 'failed'));
