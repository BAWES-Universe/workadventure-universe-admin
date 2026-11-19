-- When a renewal last held more of a room: a spending cap counts the room in the period of its last renewal too, not only the one it began in.
ALTER TABLE "meter_reservations" ADD COLUMN "last_renewed_at" TIMESTAMP(3);
