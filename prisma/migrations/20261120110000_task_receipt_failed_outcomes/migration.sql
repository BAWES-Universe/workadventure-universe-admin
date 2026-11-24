-- Receipts that tell the truth (0.5.0, amend 2, O4). A task can now end `failed` (nothing was verified and a computer job that ran took the
-- person's time) or `unconfirmed` (nothing was verified and at least one App action could not be confirmed), besides done, partial and refunded.
-- Additive: the column is only made wider and the check lists two more words; every row already written still satisfies it.
ALTER TABLE "task_receipts" DROP CONSTRAINT "task_receipts_outcome_check";
ALTER TABLE "task_receipts" ALTER COLUMN "outcome" TYPE VARCHAR(12);
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('done', 'partial', 'refunded', 'failed', 'unconfirmed'));
