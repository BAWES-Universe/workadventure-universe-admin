-- What the message that made a rule said, kept apart from the rule as it is corrected later (the same message again is a replay only of that)
ALTER TABLE "spend_rules" ADD COLUMN "proposal_fingerprint" VARCHAR(64);
