-- Whether a run used Universe AI, kept on the run itself. The runs a day only count (and only limit) what Universe AI ran: a Brick on its
-- owner's own key is never limited by them. Counting by the key a Brick uses NOW would change what earlier runs were when its key changes
-- (an own key removed or no longer lent moves it to Universe AI), so each run records what it used when it was made. A run that already
-- exists counts, as every run did before this.
ALTER TABLE "brick_item_runs" ADD COLUMN "universe_ai" BOOLEAN NOT NULL DEFAULT true;
