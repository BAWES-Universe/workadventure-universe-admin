-- Two permissions in the Bots group (#737): Have bots change things (bit 17, 131072) and Have bots delete or send
-- (bit 18, 262144). Together 393216.
--
-- Nothing reads them yet, so nobody gains or loses anything on the day this runs. The built-in roles get their
-- defaults: Admin (which always has every permission) and Editor (who already manage bots) both; Member change only.
-- Everyone and every custom role get neither. "|" sets the bits and keeps whatever else the role already had, so
-- running it twice changes nothing more.
UPDATE "roles"
SET "permissions" = "permissions" | 393216, "updated_at" = now()
WHERE "built_in" = true AND "key" IN ('admin', 'editor');

UPDATE "roles"
SET "permissions" = "permissions" | 131072, "updated_at" = now()
WHERE "built_in" = true AND "key" = 'member';

-- A per-bot rule may now hold the two new bits as well: Manage bots 8192, Chat nearby 16384, DM 32768, Summon 65536,
-- Have it change things 131072 and Have it delete or send 262144 = 516096. Still never both Yes and No.
ALTER TABLE "bot_access_rules" DROP CONSTRAINT "bot_access_rules_bits";
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_bits" CHECK (
    "allow" >= 0 AND "deny" >= 0 AND ("allow" & ~516096) = 0 AND ("deny" & ~516096) = 0 AND ("allow" & "deny") = 0
);
