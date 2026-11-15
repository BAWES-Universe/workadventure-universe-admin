-- A hold key the books were told to give up before any hold was made under it (the Instant executor never got an answer to its
-- reservation, then asks "is anything held under this key?"). Once a key is here, a hold that arrives later under it is refused, so a
-- reservation that was still on its way can never take credit nobody will settle or release.
CREATE TABLE "credit_closed_keys" (
    "hold_key" VARCHAR(255) NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_closed_keys_pkey" PRIMARY KEY ("hold_key")
);
