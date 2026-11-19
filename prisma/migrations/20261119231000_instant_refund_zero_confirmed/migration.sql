-- The books can confirm a give-back of nothing (an ended lot with no replacement allowed): it is recorded as that. An intent still needs an amount.
ALTER TABLE "instant_refunds" DROP CONSTRAINT IF EXISTS "instant_refunds_amount_check";
ALTER TABLE "instant_refunds" ADD CONSTRAINT "instant_refunds_amount_check" CHECK ("amount_micros" > 0 OR "confirmed_at" IS NOT NULL);
