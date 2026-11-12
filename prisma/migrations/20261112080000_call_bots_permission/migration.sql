-- One permission in the Bots group: Call bots (bit 19, 524288), for calling a Brick, or a bot whose owner allows it,
-- out loud (game #2004, mock Part 18).
--
-- It starts as No for every existing bot: only Admin, which always has every permission, gets it. Editor, Member,
-- Everyone and every custom role do not, so on the day this runs nobody gains or loses anything except Admin's own
-- number, which already meant "everything". The creator, the universe's owner, super admins and the people who manage a
-- bot are let through by the check itself, not by this number. "|" sets the bit and keeps whatever else the role
-- already had, so running it twice changes nothing more.
UPDATE "roles"
SET "permissions" = "permissions" | 524288, "updated_at" = now()
WHERE "built_in" = true AND "key" = 'admin';

-- A per-bot rule may now hold Call as well: Manage bots 8192, Chat nearby 16384, DM 32768, Summon 65536, Have it change
-- things 131072, Have it delete or send 262144 and Call 524288 = 1040384. Still never both Yes and No.
ALTER TABLE "bot_access_rules" DROP CONSTRAINT "bot_access_rules_bits";
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_bits" CHECK (
    "allow" >= 0 AND "deny" >= 0 AND ("allow" & ~1040384) = 0 AND ("deny" & ~1040384) = 0 AND ("allow" & "deny") = 0
);
