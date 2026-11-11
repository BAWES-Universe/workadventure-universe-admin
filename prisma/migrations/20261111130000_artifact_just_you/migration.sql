-- "Just you" for things a bot makes (game #1994): an artifact its owner keeps to themselves. Two new tables; nothing
-- existing changes. `artifacts.open_scope` takes one more value, "me", which no artifact has until its owner picks it.

-- One opening of a private artifact by its owner: the address Orbit serves its files at for that opening.
-- CreateTable
CREATE TABLE "artifact_passes" (
    "id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "cookie_hash" VARCHAR(64),
    "redeemed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_passes_pkey" PRIMARY KEY ("id")
);

-- Files whose address was handed out before their artifact became private, until the bucket has removed them.
-- CreateTable
CREATE TABLE "artifact_retired_files" (
    "key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_retired_files_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "artifact_passes_token_hash_key" ON "artifact_passes"("token_hash");

-- CreateIndex
CREATE INDEX "artifact_passes_artifact_id_idx" ON "artifact_passes"("artifact_id");

-- CreateIndex
CREATE INDEX "artifact_passes_user_id_idx" ON "artifact_passes"("user_id");

-- CreateIndex
CREATE INDEX "artifact_passes_expires_at_idx" ON "artifact_passes"("expires_at");

-- CreateIndex
CREATE INDEX "artifact_retired_files_created_at_idx" ON "artifact_retired_files"("created_at");

-- AddForeignKey
ALTER TABLE "artifact_passes" ADD CONSTRAINT "artifact_passes_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_passes" ADD CONSTRAINT "artifact_passes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
