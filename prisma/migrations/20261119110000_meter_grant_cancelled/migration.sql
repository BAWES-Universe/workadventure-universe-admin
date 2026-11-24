-- A grant taken back before it started never ran: its dates stay as given, and this says it was cancelled.
ALTER TABLE "meter_grants" ADD COLUMN "cancelled_at" TIMESTAMP(3);
