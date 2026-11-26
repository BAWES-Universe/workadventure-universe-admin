-- Research Apps on by default (26 Nov 2026): every Brick's owner can have their Brick search the web from the first message, paid from the
-- Instant Apps credit Universe gives each person. Khalid's money calls of 26 Nov: the credit is enough to get hooked on what research can
-- do ($2.00 a month for each person, renewed on the 1st), and the most Instant may owe the provider in a month, for everyone together, is
-- scaled to it ($200.00). Both stay what they always were: values on the Grants and Limits screens that a super admin changes there at any time.
--
-- Rules this file keeps (as the launch defaults did):
--  * Never overwrites a choice. Each value moves only while it is still exactly the old seeded one: a ceiling still at $1.00, and a default
--    grant still at its seeded first version ($0.10 once, for everyone, never saved again). Anything a super admin saved stays as it is.
--  * Runs once, like every migration.
-- Money is in millionths of a dollar.

-- ---------------------------------------------------------------------------------------------------------------------
-- One question's runs are counted (the "most research runs for one question" limit): the index that count reads.
-- instant_runs is small (Instant only started with 0.5.0), so a plain index builds at once.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "instant_runs_person_id_task_key_idx" ON "instant_runs"("person_id", "task_key");

-- ---------------------------------------------------------------------------------------------------------------------
-- Instant Apps limits
-- ---------------------------------------------------------------------------------------------------------------------
-- exposureCeilingMicros  200000000  $200.00 the most Instant may owe the provider in a month, everyone together (was the seeded $1.00)
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{exposureCeilingMicros}', '200000000'::jsonb), "updated_at" = now()
WHERE "key" = 'instant-limits'
  AND jsonb_typeof("value") = 'object'
  AND "value"->'exposureCeilingMicros' = '1000000'::jsonb;

-- maxRunsPerQuestion  8  a Brick may try another research App when the first answer is thin; one question stops at 8 runs (a count, not money)
UPDATE "app_settings"
SET "value" = "value" || '{"maxRunsPerQuestion":8}'::jsonb, "updated_at" = now()
WHERE "key" = 'instant-limits'
  AND jsonb_typeof("value") = 'object'
  AND NOT ("value" ? 'maxRunsPerQuestion');

-- ---------------------------------------------------------------------------------------------------------------------
-- The Instant Apps default grant: $2.00 a month for each signed-in person, from now (was $0.10 once)
-- ---------------------------------------------------------------------------------------------------------------------
-- Written as the Grants screen writes a new version of the default with "Now": the seeded version is superseded at this moment and version 2
-- takes over, funded by the same account. Credit already given stays. Both steps are one statement, so neither can happen without the other.
DO $$
DECLARE
  funding TEXT;
BEGIN
  UPDATE "grant_rules"
  SET "state" = 'superseded', "superseded_at" = now()
  WHERE "id" = 'seed-default-instant_apps-v1'
    AND "program_id" = 'seed-default-instant_apps'
    AND "state" = 'current'
    AND "amount" = 100000
    AND "schedule" = 'once'
    AND "share" = 'each'
    AND "recipient_type" = 'all'
    AND EXISTS (SELECT 1 FROM "grant_programs" WHERE "id" = 'seed-default-instant_apps' AND "status" = 'active' AND "kind" = 'default')
    AND NOT EXISTS (SELECT 1 FROM "grant_rules" WHERE "program_id" = 'seed-default-instant_apps' AND "version" > 1)
  RETURNING "funding_account_id" INTO funding;

  IF funding IS NOT NULL THEN
    INSERT INTO "grant_rules" ("id", "program_id", "version", "state", "funding_account_id", "covers", "benefit_kind", "amount", "schedule", "share", "recipient_type", "claim_starts_at", "settlement", "created_by_id", "created_at")
    VALUES ('seed-default-instant_apps-v2', 'seed-default-instant_apps', 2, 'current', funding, ARRAY['instant_apps']::TEXT[], 'replace', 2000000, 'monthly', 'each', 'all', now(), 'free', 'system', now());
  END IF;
END $$;
