-- The Budget page: a record of every change to a money, limit or warning number (who, when, which number, old and new value), and the
-- starting values of the page's own settings (warning levels and how a forecast is read). A starting value is only written where nothing
-- is saved: a number a super admin already set is never overwritten.

CREATE TABLE "budget_changes" (
  "id" TEXT NOT NULL,
  "store" VARCHAR(20) NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "old_value" BIGINT,
  "new_value" BIGINT,
  "changed_by_id" TEXT,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" VARCHAR(200),
  CONSTRAINT "budget_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "budget_changes_changed_at_idx" ON "budget_changes"("changed_at");
CREATE INDEX "budget_changes_store_key_changed_at_idx" ON "budget_changes"("store", "key", "changed_at");

-- Starting values of the page's settings. They are saved values like any other: the page edits them, and nothing in the code holds them.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES (
  'budget',
  '{"warnFirstPercent":50,"warnSecondPercent":80,"warnThirdPercent":95,"sampleDays":7,"sparseDays":3,"burstPercent":50,"raiseRoomPercent":110,"raiseHeadroomPercent":150,"idleDays":30,"checkMinutes":15}'::jsonb,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
