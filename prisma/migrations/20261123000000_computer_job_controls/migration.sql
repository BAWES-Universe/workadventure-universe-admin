-- Computer job controls (pause, resume, do this next, cancel one job, notes to a job, its Activity list). Additive only: every column has a default or is
-- nullable, and every table is new, so a server of the version before this runs beside it unchanged (it never reads them). A job of before this has rank 0,
-- was never paused and has nothing billed by a pause, which is exactly what it was.

-- AlterTable
ALTER TABLE "computer_jobs" ADD COLUMN     "continues_job_id" TEXT,
ADD COLUMN     "note_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_why" VARCHAR(10),
ADD COLUMN     "pauses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "queue_rank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "seconds_billed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "computer_job_notes" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" VARCHAR(4000) NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "computer_job_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "computer_job_steps" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_job_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "computer_job_pauses" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "why" VARCHAR(10) NOT NULL,
    "room_key" VARCHAR(255),
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "at" TIMESTAMP(3) NOT NULL,
    "booked_at" TIMESTAMP(3),

    CONSTRAINT "computer_job_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "computer_job_notes_job_id_seq_key" ON "computer_job_notes"("job_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "computer_job_steps_job_id_seq_key" ON "computer_job_steps"("job_id", "seq");

-- CreateIndex
CREATE INDEX "computer_job_pauses_booked_at_at_idx" ON "computer_job_pauses"("booked_at", "at");

-- CreateIndex
CREATE UNIQUE INDEX "computer_job_pauses_job_id_n_key" ON "computer_job_pauses"("job_id", "n");

-- CreateIndex
CREATE INDEX "computer_jobs_bot_id_status_queue_rank_idx" ON "computer_jobs"("bot_id", "status", "queue_rank");

-- AddForeignKey
ALTER TABLE "computer_job_notes" ADD CONSTRAINT "computer_job_notes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computer_job_steps" ADD CONSTRAINT "computer_job_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "computer_job_pauses" ADD CONSTRAINT "computer_job_pauses_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A paused job is a job in line with queued_for 'paused': the check from 20261112120000_brick_computer is widened to let it (a server of before this never writes it).
ALTER TABLE "computer_jobs" DROP CONSTRAINT "computer_jobs_queued_for_check";
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_queued_for_check" CHECK ("queued_for" IS NULL OR "queued_for" IN ('turn', 'allowance', 'busy', 'pool', 'paused'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_paused_why_check" CHECK ("paused_why" IS NULL OR "paused_why" IN ('person', 'allowance', 'rule'));
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_billed_check" CHECK ("seconds_billed" >= 0 AND "pauses" >= 0 AND "note_seq" >= 0);
ALTER TABLE "computer_job_notes" ADD CONSTRAINT "computer_job_notes_state_check" CHECK ("state" IN ('pending', 'sent') AND "seq" >= 1);
ALTER TABLE "computer_job_pauses" ADD CONSTRAINT "computer_job_pauses_check" CHECK ("why" IN ('person', 'allowance', 'rule') AND "n" >= 1 AND "seconds" >= 0);
