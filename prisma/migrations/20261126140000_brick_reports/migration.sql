-- Brick reports (mock "Brick reports inbox"): notes Bricks send to the Universe team, counted into problems. Nothing here names a person.
CREATE TABLE "brick_report_problems" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "area" VARCHAR(20) NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'new',
    "came_back" BOOLEAN NOT NULL DEFAULT false,
    "state_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_report_problems_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "brick_report_problems_kind_area_last_seen_at_idx" ON "brick_report_problems"("kind", "area", "last_seen_at");
CREATE INDEX "brick_report_problems_state_idx" ON "brick_report_problems"("state");

CREATE TABLE "brick_report_notes" (
    "id" TEXT NOT NULL,
    "problem_id" TEXT,
    "bot_id" TEXT,
    "person_key" VARCHAR(64),
    "kind" VARCHAR(20) NOT NULL,
    "area" VARCHAR(20) NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "tried" VARCHAR(280) NOT NULL DEFAULT '',
    "stopped" VARCHAR(280) NOT NULL DEFAULT '',
    "idea" VARCHAR(280) NOT NULL DEFAULT '',
    "effect" VARCHAR(20) NOT NULL,
    "context" JSONB,
    "reopened" BOOLEAN NOT NULL DEFAULT false,
    "take_back_hash" VARCHAR(64) NOT NULL,
    "taken_back_at" TIMESTAMP(3),
    "day" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_report_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "brick_report_notes_problem_id_created_at_idx" ON "brick_report_notes"("problem_id", "created_at");
CREATE INDEX "brick_report_notes_bot_id_day_idx" ON "brick_report_notes"("bot_id", "day");

ALTER TABLE "brick_report_notes" ADD CONSTRAINT "brick_report_notes_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "brick_report_problems"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brick_report_notes" ADD CONSTRAINT "brick_report_notes_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
