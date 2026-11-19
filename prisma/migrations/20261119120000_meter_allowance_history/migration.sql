-- The allowance that applied in each month, kept so a past month is never reworked with today's allowance.
CREATE TABLE "meter_allowance_changes" (
    "id" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "allowance_micros" BIGINT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_allowance_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meter_allowance_changes_effective_from_idx" ON "meter_allowance_changes"("effective_from");

-- What is saved today is taken to have applied since the beginning (it is what the report used for every month until now), and a figure
-- that was waiting for a later day begins on that day. "No allowance" is saved too, as a row with no figure: otherwise an allowance set
-- later would be read back over every month before it, which had none
INSERT INTO "meter_allowance_changes" ("id", "effective_from", "allowance_micros")
SELECT gen_random_uuid()::text, TIMESTAMP '1970-01-01 00:00:00',
  CASE WHEN saved.figure ~ '^[0-9]+$' THEN saved.figure::bigint ELSE NULL END
FROM (SELECT (SELECT value->>'memberAllowanceMicros' FROM "app_settings" WHERE "key" = 'meter') AS figure) AS saved;

INSERT INTO "meter_allowance_changes" ("id", "effective_from", "allowance_micros")
SELECT gen_random_uuid()::text, (value->'memberAllowanceLater'->>'from')::timestamp, (value->'memberAllowanceLater'->>'micros')::bigint
FROM "app_settings" WHERE "key" = 'meter' AND value->'memberAllowanceLater'->>'micros' ~ '^[0-9]+$' AND value->'memberAllowanceLater'->>'from' IS NOT NULL;
