-- A computer job can end because a rule the person said in chat did not let it take more room (paying spec 3, part O4).
-- Only the list of allowed words changes: no row is touched.
ALTER TABLE "computer_jobs" DROP CONSTRAINT "computer_jobs_ended_by_check";
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_ended_by_check" CHECK ("ended_by" IS NULL OR "ended_by" IN ('person', 'allowance', 'pool', 'off', 'deleted', 'error', 'unanswered', 'rule'));
