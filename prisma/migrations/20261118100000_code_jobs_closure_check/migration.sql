-- Code jobs: the provider's log of a session (runs that were not ours) is read again until it has been read after the session was confirmed
-- deleted. A job that ended before this column existed is counted as already checked, so the sweep does not read old logs again.
ALTER TABLE "code_jobs" ADD COLUMN "nested_checked_at" TIMESTAMP(3);
UPDATE "code_jobs" SET "nested_checked_at" = COALESCE("finished_at", "created_at") WHERE "provider_state" = 'closed';
