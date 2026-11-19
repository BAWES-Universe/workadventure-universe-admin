-- The longest an admitted spoken reply may be, kept on its row: the month's speech Limit holds what the reply was admitted for, not what the
-- setting says later. Rows from before this stay empty and are held at the setting as it is now.
ALTER TABLE "voice_reply_uses" ADD COLUMN "seconds" INTEGER;
