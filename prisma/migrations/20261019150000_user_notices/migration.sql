-- Notices (#374, part 4): one thing Orbit tells one person once, until they dismiss it. A new table; nothing existing is touched.

-- CreateTable
CREATE TABLE "user_notices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "badge" VARCHAR(20),
    "href" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_at" TIMESTAMP(3),

    CONSTRAINT "user_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_notices_user_id_dedupe_key_key" ON "user_notices"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "user_notices_user_id_dismissed_at_idx" ON "user_notices"("user_id", "dismissed_at");

-- AddForeignKey
ALTER TABLE "user_notices" ADD CONSTRAINT "user_notices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
