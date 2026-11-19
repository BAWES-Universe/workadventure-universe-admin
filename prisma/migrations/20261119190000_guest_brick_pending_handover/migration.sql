-- A hand-over of a guest's chat that failed when the person signed in, kept until their next room access
CREATE TABLE "guest_brick_pending_handovers" (
    "guest_key" VARCHAR(255) NOT NULL,
    "user_id" TEXT NOT NULL,
    "kept_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_brick_pending_handovers_pkey" PRIMARY KEY ("guest_key")
);

CREATE INDEX "guest_brick_pending_handovers_user_id_idx" ON "guest_brick_pending_handovers"("user_id");

ALTER TABLE "guest_brick_pending_handovers" ADD CONSTRAINT "guest_brick_pending_handovers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
