-- Round 8, B2 (CodeRabbit O25): validates the check added NOT VALID by the migration before this one. It is a separate migration so the scan of the existing rows runs in its own transaction and holds only a lock that lets reads and writes go on.
-- The previous migration already cleared every row that had both; a database that ran its earlier form already has the check validated, and this is then a no-op. Safe to run twice.
ALTER TABLE "computer_jobs" VALIDATE CONSTRAINT "computer_jobs_prep_unbilled";
