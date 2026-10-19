-- Bot permissions (#426): three new permissions next to Manage bots (bit 13): Chat with bots nearby (bit 14, 16384),
-- DM bots (bit 15, 32768) and Summon bots (bit 16, 65536). Together 114688.
--
-- Nobody gains or loses anything. Before this, everyone could chat with a bot nearby and summon it, guests too, so the
-- built-in Everyone role gets all three in every universe: on day one every bot works exactly as it does now. The
-- built-in Admin role always has every permission, so it gets them too (the Roles page locks Admin's switches on).
-- Admin was 16383 (bits 0 to 13) and becomes 131071; Everyone keeps what it had and gains the three (0 becomes 114688).
-- Editor, Member and every custom role are not touched: they add to Everyone's permissions, as in Discord.
--
-- "|" sets the bits and keeps whatever else the role already had, so running it twice changes nothing more.
UPDATE "roles"
SET "permissions" = "permissions" | 114688, "updated_at" = now()
WHERE "built_in" = true AND "key" IN ('everyone', 'admin');
