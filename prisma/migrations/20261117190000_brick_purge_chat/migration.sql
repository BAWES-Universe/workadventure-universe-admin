-- A deleted Brick keeps nothing in chat (register R29): the purge writes that its chat rooms are still to clear, and the bot server (which holds the
-- chat account) asks for that list and confirms each Brick it cleared. Only a flag on the existing retry note: no content, no name.
ALTER TABLE "brick_purges" ADD COLUMN "chat_pending" BOOLEAN NOT NULL DEFAULT false;
