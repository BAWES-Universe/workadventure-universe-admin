-- Launch defaults for 0.5.0: every Limit and default grant that real computers, Instant Apps and credit need starts FILLED IN, small and safe.
--
-- Until now these started empty on purpose ("nothing is assumed"), so a fresh deploy refused every computer job and every Instant run,
-- and nobody had any credit until someone typed numbers into Limits and Grants. Nothing here is enforced by code: these are only the
-- values the Limits and Grants screens start with. A super admin can change any of them there at any time, and nobody has to.
--
-- Rules this file keeps:
--  * Never overwrites. A key that already has a value in the saved settings keeps it (the saved value wins over the seeded one), and a
--    category that already has a default program of any state (even an ended one) is left alone.
--  * Runs once, like every migration, so a value a super admin empties later stays empty.
--  * Every figure is small: the whole of what Orbit can owe for computers and Instant in a month is capped by the two ceilings below
--    ($2.00 for the computer pool, $1.00 for Instant), whatever the amounts given out add up to. Money is in millionths of a dollar.

-- ---------------------------------------------------------------------------------------------------------------------
-- Computers and the platform's rollout budget (the "meter" settings)
-- ---------------------------------------------------------------------------------------------------------------------
-- memberAllowanceMicros   250000     $0.25 a member a month: about 5 to 25 small jobs (a job is about $0.01 to $0.05)
-- poolCeilingMicros       2000000    $2.00 a month for the whole computer pool, reserve included. Under the Agent37 wallet (about $5), which is the last wall
-- reserveMicros           500000     $0.50 kept back for late settlement and recovery, never given to new work
-- storageMicrosPerGbMonth 90000      $0.09 a GB a month: Agent37's own disk price (an asleep computer is billed for its disk only)
-- atOnceMember            1          one job at a time for each member
-- atOnceAll               3          three jobs at once in all
-- rolloutBudgetMicros     20000000   $20.00 of default credit the platform may issue in a month. Credit that is not used costs nothing,
--                                    and what can be spent is capped by the two ceilings, so this only decides how many people are given credit
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES (
  'meter',
  '{"memberAllowanceMicros":250000,"poolCeilingMicros":2000000,"reserveMicros":500000,"storageMicrosPerGbMonth":90000,"atOnceMember":1,"atOnceAll":3,"rolloutBudgetMicros":20000000}'::jsonb,
  now()
)
ON CONFLICT ("key") DO UPDATE SET "value" = CASE
  WHEN jsonb_typeof("app_settings"."value") = 'object' THEN
    -- the seeded numbers first, then what was already saved over them: a saved value always wins.
    -- A monthly allowance that is waiting for the 1st is a saved choice too: do not put another one beside it.
    (EXCLUDED."value" - CASE WHEN "app_settings"."value" ? 'memberAllowanceLater' THEN 'memberAllowanceMicros' ELSE '' END) || "app_settings"."value"
  ELSE "app_settings"."value"
END;

-- ---------------------------------------------------------------------------------------------------------------------
-- Instant Apps (the "instant-limits" settings)
-- ---------------------------------------------------------------------------------------------------------------------
-- maxRunMicros          30000      $0.03 the most one run may cost, fees included (a search is under $0.01; a very big page read is refused)
-- exposureCeilingMicros 1000000    $1.00 the most Instant may owe Composio in a month (held runs, unknown charges and settled charges together)
-- pauseFailureRateBps   2000       Instant pauses itself when 20% of recent runs fail...
-- pauseMinRuns          10         ...once at least 10 runs have happened
-- The "didn't work" give-back limits and the markup are left empty: the button is gone, a failure on our side is never charged, and the
-- person pays Composio's charge as it is. The waiting times already have their own recommended values in code.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES (
  'instant-limits',
  '{"maxRunMicros":30000,"exposureCeilingMicros":1000000,"pauseFailureRateBps":2000,"pauseMinRuns":10}'::jsonb,
  now()
)
ON CONFLICT ("key") DO UPDATE SET "value" = CASE
  WHEN jsonb_typeof("app_settings"."value") = 'object' THEN EXCLUDED."value" || "app_settings"."value"
  ELSE "app_settings"."value"
END;

-- ---------------------------------------------------------------------------------------------------------------------
-- Default grants (paid by the platform's own account, to every signed-in member, free: never owed by anyone)
-- ---------------------------------------------------------------------------------------------------------------------
-- Instant Apps: $0.10 once (about 10 searches). Then people can ask for more.
INSERT INTO "grant_programs" ("id", "category_id", "kind", "label", "created_by_id", "created_at", "status")
SELECT 'seed-default-instant_apps', 'instant_apps', 'default', 'Default', 'system', now(), 'active'
WHERE NOT EXISTS (SELECT 1 FROM "grant_programs" WHERE "category_id" = 'instant_apps' AND "kind" = 'default')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "grant_rules" ("id", "program_id", "version", "state", "funding_account_id", "covers", "benefit_kind", "amount", "schedule", "share", "recipient_type", "claim_starts_at", "settlement", "created_by_id", "created_at")
SELECT 'seed-default-instant_apps-v1', 'seed-default-instant_apps', 1, 'current', 'funding-platform', ARRAY['instant_apps']::TEXT[], 'replace', 100000, 'once', 'each', 'all', now(), 'free', 'system', now()
WHERE EXISTS (SELECT 1 FROM "grant_programs" WHERE "id" = 'seed-default-instant_apps')
  AND NOT EXISTS (SELECT 1 FROM "grant_rules" WHERE "program_id" = 'seed-default-instant_apps')
ON CONFLICT ("id") DO NOTHING;

-- Computers: the same amount as the monthly allowance above (computer jobs follow that one allowance, and the default is its mirror on the
-- Grants screen), renewed on the 1st. If a super admin had already saved another allowance it is that one that is mirrored, and if none
-- exists there is nothing to mirror.
INSERT INTO "grant_programs" ("id", "category_id", "kind", "label", "created_by_id", "created_at", "status")
SELECT 'seed-default-computers', 'computers', 'default', 'Default', 'system', now(), 'active'
WHERE NOT EXISTS (SELECT 1 FROM "grant_programs" WHERE "category_id" = 'computers' AND "kind" = 'default')
  AND (SELECT "value"->>'memberAllowanceMicros' FROM "app_settings" WHERE "key" = 'meter') ~ '^[1-9][0-9]{0,15}$'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "grant_rules" ("id", "program_id", "version", "state", "funding_account_id", "covers", "benefit_kind", "amount", "schedule", "share", "recipient_type", "claim_starts_at", "settlement", "created_by_id", "created_at")
SELECT 'seed-default-computers-v1', 'seed-default-computers', 1, 'current', 'funding-platform', ARRAY['computers']::TEXT[], 'replace',
  ("value"->>'memberAllowanceMicros')::BIGINT, 'monthly', 'each', 'all', now(), 'free', 'system', now()
FROM "app_settings"
WHERE "key" = 'meter'
  AND EXISTS (SELECT 1 FROM "grant_programs" WHERE "id" = 'seed-default-computers')
  AND NOT EXISTS (SELECT 1 FROM "grant_rules" WHERE "program_id" = 'seed-default-computers')
ON CONFLICT ("id") DO NOTHING;
