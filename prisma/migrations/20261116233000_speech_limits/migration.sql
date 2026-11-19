-- Spending stop on the speech Universe AI pays for (0.5.0 spend caps, gap F4): two Limits, in SECONDS, that every spoken reply and every
-- voice note Universe AI pays for is held against BEFORE it is made (lib/speech-cap.ts). Speech has no price Universe could know, so the
-- stop counts what is certain. They start FILLED IN, like the other launch Limits, and a super admin can change them.
--
--  speechCeilingSeconds        360000  100 hours a month for everyone together (audio heard plus voice spoken, live calls and voice notes)
--  speechMemberCeilingSeconds   36000  10 hours a month for one person: far more than a person talks to Bricks in a month, and far less than
--                                      a call left open on a loop could use
--
-- Never overwrites: a value that is already saved keeps winning. 0 pauses Universe AI speech, and an emptied Limit stops it, until one is set again.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('meter', '{"speechCeilingSeconds":360000,"speechMemberCeilingSeconds":36000}'::jsonb, now())
ON CONFLICT ("key") DO UPDATE SET "value" = CASE
  WHEN jsonb_typeof("app_settings"."value") = 'object' THEN EXCLUDED."value" || "app_settings"."value"
  ELSE "app_settings"."value"
END;
