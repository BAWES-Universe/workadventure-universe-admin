-- Which run of reserved tries a call joined. When the reservations of a form lapse and a new one starts the count again, the epoch moves on, so a
-- call that was still in flight from before releases nothing from the new count (it would take away a try that belongs to a call in flight now).
ALTER TABLE "app_key_requests" ADD COLUMN "reserved_epoch" INTEGER NOT NULL DEFAULT 0;
