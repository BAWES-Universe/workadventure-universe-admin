-- Routines that come with a Brick template (game #2008) arrive SWITCHED OFF: paused, with nothing due, by the template.
-- "template" joins the reasons an item can be paused. Nothing that exists is changed: every row already holds one of the
-- old reasons (or none), and none is written here.
ALTER TABLE "brick_items" DROP CONSTRAINT "brick_items_paused_by_check";
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_paused_by_check" CHECK ("paused_by" IS NULL OR "paused_by" IN ('owner', 'brick_deleted', 'goal', 'template'));
