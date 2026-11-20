-- A refusal seen inside the minute after a key's last recorded good call is kept apart instead of dropped (it may be older than a good call that was
-- not written down): a second one before a good call after it marks the key lost, a good call after it clears it
ALTER TABLE "app_connections" ADD COLUMN "held_refusal_at" TIMESTAMP(3);
