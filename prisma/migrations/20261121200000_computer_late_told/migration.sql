-- The one follow-up that tells a person an App let go unconfirmed (its hold released, nothing charged) went out after all, once the provider's log confirmed it: when it was told (or can never be).
-- Null for every row that exists: a job already late-corrected before this deploy is never offered it (see the cutoff below).
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "late_told_at" TIMESTAMP(3);

-- Only a confirmation that came AFTER this deploy can ever be offered: the moment of the deploy, kept once (an existing value is left alone).
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('computer_late_report_since', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now())
ON CONFLICT ("key") DO NOTHING;
