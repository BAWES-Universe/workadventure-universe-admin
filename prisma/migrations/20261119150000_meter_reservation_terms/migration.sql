-- What each authorized stretch of a lease was priced at (see the schema); empty on older rows
ALTER TABLE "meter_reservations" ADD COLUMN "terms" JSONB;
