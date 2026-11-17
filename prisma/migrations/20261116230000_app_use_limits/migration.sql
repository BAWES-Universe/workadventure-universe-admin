-- Spending stop for connected ready-made Apps that Universe pays for (audit F3): two Limits that every paid use of such an App is held
-- against BEFORE it is made (lib/app-use-cap.ts). They start FILLED IN, like the other launch Limits, and a super admin can change them.
--
--  appUseCeilingMicros        10000000  $10.00 a month for everyone together. At the provider's own list prices that is about 20,000 ordinary
--                                       steps ($0.0005 each), the month's free managed calls on our plan; a premium step ($0.002) takes four times as much
--  appUseMemberCeilingMicros  500000    $0.50 a month for one person: about 1,000 ordinary steps, far more than a person uses by hand and far
--                                       less than a loop gone wrong could burn
--
-- Never overwrites: a value that is already saved keeps winning. 0 pauses the use, and an emptied Limit stops it, until one is set again.
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES ('meter', '{"appUseCeilingMicros":10000000,"appUseMemberCeilingMicros":500000}'::jsonb, now())
ON CONFLICT ("key") DO UPDATE SET "value" = CASE
  WHEN jsonb_typeof("app_settings"."value") = 'object' THEN EXCLUDED."value" || "app_settings"."value"
  ELSE "app_settings"."value"
END;
