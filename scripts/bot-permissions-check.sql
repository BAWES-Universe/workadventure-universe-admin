-- Bot permissions (#426) migration check. Read-only: safe on production, before and after the migration.
--
--   psql "$DATABASE_URL" -At -F ' ' -f scripts/bot-permissions-check.sql > before.txt   (before the release)
--   psql "$DATABASE_URL" -At -F ' ' -f scripts/bot-permissions-check.sql > after.txt    (after it)
--   diff before.txt after.txt
--
-- Part 1 lists every role with its permissions leaving out the three new bits (16384 + 32768 + 65536 = 114688), so
-- nothing in it may differ between before and after: that is "0 differences in who can do what". Part 2 is empty
-- before and, after, lists exactly the built-in Everyone and Admin of every universe, all three bits on; no other role
-- may appear. The last line counts what is wrong: it must say 0 after the migration (before it, it counts the
-- Everyone and Admin rows the migration is about to fix).
-- So the diff shows only extra part 2 lines and the last number going to 0. Anything in part 1 is a real difference.
\echo part1: universe, role, permissions without the new bits
SELECT "universe_id", "key", ("permissions" & ~114688::bigint)::text
FROM "roles"
ORDER BY "universe_id", "key";

\echo part2: roles that carry the new bits (after: exactly the Everyone and Admin of every universe)
SELECT "universe_id", "key", (("permissions" & 114688::bigint) = 114688)::text AS "all_three_on"
FROM "roles"
WHERE ("permissions" & 114688::bigint) <> 0
ORDER BY "universe_id", "key";

\echo wrong: universes whose Everyone or Admin lacks a bit, plus other roles that have one
SELECT count(*)::text
FROM "roles"
WHERE (("built_in" AND "key" IN ('everyone', 'admin')) AND ("permissions" & 114688::bigint) <> 114688)
   OR (NOT ("built_in" AND "key" IN ('everyone', 'admin')) AND ("permissions" & 114688::bigint) <> 0);
