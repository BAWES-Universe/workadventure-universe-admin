-- The way a computer job took and what the whole task was expected to cost when it was chosen (0.5.0 gap T3, the router by expected cost).
-- Jobs that exist keep the computer as their way and no expected figure.
ALTER TABLE "computer_jobs" ADD COLUMN "route" VARCHAR(10) NOT NULL DEFAULT 'computer';
ALTER TABLE "computer_jobs" ADD COLUMN "expected_micros" BIGINT;
