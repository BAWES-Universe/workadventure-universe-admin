-- Visiting Bricks is ON by default for every universe, existing ones included (game #2005).
--
-- The first migration (20261112123000_visiting_bricks) started every universe that existed then with the switch OFF. The
-- decision since is that the switch is ON everywhere to begin with, and a host keeps their own off switch. That first
-- migration has already run on dev, so it is left as it was and this one turns the switch on for every universe.
-- Nothing else changes. The column's default is already "true" for a universe made from now on.

UPDATE "universes" SET "allow_visiting_bricks" = true WHERE "allow_visiting_bricks" = false;
