-- A usage row for a look Universe AI's vision took at an image (game: the describe call for a model that can't see). Universe pays for it and
-- it is the person's Universe AI use, but it is not a reply: every reply count leaves it out. Rows before this were never image looks.
ALTER TABLE "bots_ai_usage" ADD COLUMN "image_read" BOOLEAN NOT NULL DEFAULT false;
