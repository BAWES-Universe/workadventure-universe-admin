-- Call (game #2004, mock Part 18): a seventh thing a per-bot rule can say No / Default / Yes about, bit 19 (524288) of the
-- rule numbers. It is not a role permission, so no role changes: Call starts as No for every existing bot, and only the
-- bot's creator, its universe's owner, super admins, Admin and the people who manage the bot call it until a rule says Yes.
--
-- A per-bot rule may now hold Manage bots 8192, Chat nearby 16384, DM 32768, Summon 65536, Have it change things 131072,
-- Have it delete or send 262144 and Call 524288 = 1040384. Still never both Yes and No.
ALTER TABLE "bot_access_rules" DROP CONSTRAINT "bot_access_rules_bits";
ALTER TABLE "bot_access_rules" ADD CONSTRAINT "bot_access_rules_bits" CHECK (
    "allow" >= 0 AND "deny" >= 0 AND ("allow" & ~1040384) = 0 AND ("deny" & ~1040384) = 0 AND ("allow" & "deny") = 0
);
