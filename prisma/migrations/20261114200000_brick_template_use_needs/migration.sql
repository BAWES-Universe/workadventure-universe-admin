-- A Brick made from a template keeps what the template said it needs (game #2008), so "Setup required" and the gate that
-- keeps a template's routines switched off hold after the template is gone (its source Brick removed for good).
ALTER TABLE "brick_template_uses" ADD COLUMN "needs" JSONB NOT NULL DEFAULT '[]';

-- Bricks already made from a template take the needs of the version they took.
UPDATE "brick_template_uses" AS u
SET "needs" = v."needs"
FROM "brick_template_versions" AS v
WHERE v."template_id" = u."template_id" AND v."number" = u."version_number";
