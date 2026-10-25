-- The browsers and installed apps where people turned on notifications (#863). New table, nothing existing changes.

-- CreateTable
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" VARCHAR(1000) NOT NULL,
    "p256dh" VARCHAR(200) NOT NULL,
    "auth" VARCHAR(100) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_notified_at" TIMESTAMP(3),

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_endpoint_key" ON "push_devices"("endpoint");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
