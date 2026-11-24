-- A key form's try is reserved while the service is asked, and counted only when the service refuses the key. A reservation that is never
-- released (the database failed at that moment) lapses on its own, so the form never stays shut for a service that never refused the key.
ALTER TABLE "app_key_requests" ADD COLUMN "reserved_tries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_key_requests" ADD COLUMN "reserved_at" TIMESTAMP(3);
