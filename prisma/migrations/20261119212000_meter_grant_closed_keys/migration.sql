-- A grant key an admin was told was not saved: a later try under it is refused (see the extra-usage status route).
CREATE TABLE "meter_grant_closed_keys" (
    "grant_key" VARCHAR(255) NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_grant_closed_keys_pkey" PRIMARY KEY ("grant_key")
);
