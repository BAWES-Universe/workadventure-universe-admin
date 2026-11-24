-- A try on a key form is held while the service is asked, and the hold ends by itself if nobody gives it back (a refund that could not be written
-- no longer costs the person a try for good). Nothing is migrated: a form's `tries` stays the count of keys the service refused.

-- CreateTable
CREATE TABLE "app_key_holds" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_key_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_key_holds_request_id_idx" ON "app_key_holds"("request_id");

-- AddForeignKey
ALTER TABLE "app_key_holds" ADD CONSTRAINT "app_key_holds_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "app_key_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
