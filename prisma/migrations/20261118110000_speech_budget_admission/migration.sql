-- Speech and Apps follow the budget (billing consensus v2, Brief F; docs/speech-admission-contract.md).
--
-- 1. Speech in money. Hearing and speaking are priced by a versioned rate card (app_settings 'speech-rates', lib/speech-rates.ts) and the stop is
--    `speechBudgetMicros` in the meter settings, in millionths of a dollar. The 100 hours that #981 allowed are converted into money at the most
--    expensive rate of the card, so the budget is never lower than what 100 hours of any mix could cost: nothing that was allowed is lowered.
--    The hour figure stays as information; the per-person entitlement (`speechMemberCeilingSeconds`) stays as it is.
-- 2. Admission by the reply's turn id. A reply admitted by a game that names the reply on its receipt (contract 2) holds its money until that
--    receipt arrives, never on a timer; a reply admitted without it (contract 1, an older game) holds for the saved `legacyHoldSeconds`.
--    Live hearing is admitted in windows (voice_hearing_windows) renewed in the background.
-- 3. "Give more" for one entitlement: speech or Apps, for one person (meter_entitlement_grants).
--
-- Every starting value is inserted only where nothing is saved: a saved value always wins, and nothing here overwrites one.

ALTER TABLE "voice_reply_uses"
  ADD COLUMN "contract" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "member_seconds" INTEGER,
  ADD COLUMN "hold_micros" BIGINT,
  ADD COLUMN "rate_version" INTEGER,
  ADD COLUMN "provider" VARCHAR(64),
  ADD COLUMN "settled_at" TIMESTAMP(3),
  ADD COLUMN "settled_seconds" INTEGER,
  ADD COLUMN "settled_micros" BIGINT;

-- What the speech budget counts for a reply still waiting for its receipt is read by month, then by whether it is settled
CREATE INDEX "voice_reply_uses_created_at_settled_at_idx" ON "voice_reply_uses"("created_at", "settled_at");

ALTER TABLE "voice_note_turns"
  ADD COLUMN "hold_micros" BIGINT,
  ADD COLUMN "rate_version" INTEGER;

CREATE TABLE "voice_hearing_windows" (
  "id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "window_id" VARCHAR(255) NOT NULL,
  "person_key" VARCHAR(320) NOT NULL,
  "provider" VARCHAR(64),
  "rate_version" INTEGER NOT NULL,
  "admitted_seconds" INTEGER NOT NULL,
  "used_seconds" INTEGER NOT NULL DEFAULT 0,
  "hold_micros" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMP(3),
  CONSTRAINT "voice_hearing_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_hearing_windows_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "voice_hearing_windows_bot_id_window_id_key" ON "voice_hearing_windows"("bot_id", "window_id");
CREATE INDEX "voice_hearing_windows_person_key_created_at_idx" ON "voice_hearing_windows"("person_key", "created_at");
CREATE INDEX "voice_hearing_windows_closed_at_created_at_idx" ON "voice_hearing_windows"("closed_at", "created_at");

CREATE TABLE "meter_entitlement_grants" (
  "id" TEXT NOT NULL,
  "grant_key" VARCHAR(255) NOT NULL,
  "person_id" TEXT NOT NULL,
  "scope" VARCHAR(12) NOT NULL,
  "settlement" VARCHAR(10) NOT NULL,
  "multiplier" INTEGER,
  "no_limit" BOOLEAN NOT NULL DEFAULT false,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "given_by_id" TEXT NOT NULL,
  "note" VARCHAR(1000),
  "billed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meter_entitlement_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meter_entitlement_grants_scope_check" CHECK ("scope" IN ('speech', 'apps')),
  CONSTRAINT "meter_entitlement_grants_settlement_check" CHECK ("settlement" IN ('gift', 'to_bill')),
  CONSTRAINT "meter_entitlement_grants_amount_check" CHECK (("no_limit" AND "multiplier" IS NULL) OR (NOT "no_limit" AND "multiplier" >= 2))
);
CREATE UNIQUE INDEX "meter_entitlement_grants_grant_key_key" ON "meter_entitlement_grants"("grant_key");
CREATE INDEX "meter_entitlement_grants_person_id_scope_ends_at_idx" ON "meter_entitlement_grants"("person_id", "scope", "ends_at");

-- The rate card (version 1): hearing by the hour of audio, speaking by characters, for any voice company not named. Both are ESTIMATES with
-- their basis written on them (prices checked 6 and 7 Nov 2026, about $0.12 an hour of hearing and about $1.92 an hour of speaking at 15
-- characters a second). A super admin adds a company's own rate or changes these; each change is a new version.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('speech-rates', '{
  "version": 1,
  "charactersPerSecond": 15,
  "rates": [
    {"adapter": "*", "job": "hearing", "unit": "hour", "microsPerUnit": 120000, "basis": "estimate", "basisNote": "Real-time hearing, about $0.12 an hour of audio (prices checked 6 and 7 Nov 2026)"},
    {"adapter": "*", "job": "speaking", "unit": "thousand_characters", "microsPerUnit": 35556, "basis": "estimate", "basisNote": "Speaking billed by characters, about $1.92 an hour of speech at 15 characters a second (prices checked 6 and 7 Nov 2026)"}
  ],
  "history": {}
}'::jsonb, now())
ON CONFLICT ("key") DO NOTHING;

-- How long things last. All are saved settings read on every check (lib/speech-terms.ts).
--  hearingWindowSeconds      the length of one admitted stretch of live hearing
--  hearingRenewLeadSeconds   the game asks for the next window when this many seconds of the current one are left
--  receiptGraceSeconds       past this after a reply or window could have ended, a hold with no receipt is shown as unknown (it keeps counting)
--  legacyHoldSeconds         how long a reply admitted without a receipt id (an older game) holds its money: the old 10 minutes
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('speech-terms', '{"hearingWindowSeconds":60,"hearingRenewLeadSeconds":15,"receiptGraceSeconds":600,"legacyHoldSeconds":600}'::jsonb, now())
ON CONFLICT ("key") DO NOTHING;

-- The hours that were allowed, in money at the most expensive rate of the card. Only where hours are saved and no budget is: never overwrites,
-- never lowers. Hours alone stay information (the budget is the stop).
UPDATE "app_settings" AS m
SET "value" = m."value" || jsonb_build_object(
  'speechBudgetMicros',
  CEIL(
    (m."value"->>'speechCeilingSeconds')::numeric * (
      SELECT MAX(
        CASE r->>'unit'
          WHEN 'hour' THEN (r->>'microsPerUnit')::numeric / 3600
          ELSE (r->>'microsPerUnit')::numeric * COALESCE((SELECT "value"->>'charactersPerSecond' FROM "app_settings" WHERE "key" = 'speech-rates'), '15')::numeric / 1000
        END
      )
      FROM jsonb_array_elements((SELECT "value"->'rates' FROM "app_settings" WHERE "key" = 'speech-rates')) AS r
    )
  )::bigint
)
WHERE m."key" = 'meter'
  AND jsonb_typeof(m."value") = 'object'
  AND m."value" ? 'speechCeilingSeconds'
  AND NOT (m."value" ? 'speechBudgetMicros')
  AND jsonb_typeof(m."value"->'speechCeilingSeconds') = 'number';
