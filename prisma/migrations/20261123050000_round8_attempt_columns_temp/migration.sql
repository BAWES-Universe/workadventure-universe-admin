-- TEMP (drop on merge): migration 197 computer_round8_fences carries these two columns
ALTER TABLE "computer_start_attempts" ADD COLUMN "outcome" JSONB, ADD COLUMN "issued_at" TIMESTAMP(3);
