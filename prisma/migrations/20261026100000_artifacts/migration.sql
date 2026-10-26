-- Live artifacts (game #1422, Orbit #622): what a bot makes for a person, and each version of it. Two new tables;
-- nothing existing changes.

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT,
    "maker_bot_id" VARCHAR(255) NOT NULL,
    "maker_name" VARCHAR(100) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "chat_kind" VARCHAR(20),
    "chat_ref" VARCHAR(255),
    "open_scope" VARCHAR(20) NOT NULL DEFAULT 'chat',
    "change_scope" VARCHAR(20) NOT NULL DEFAULT 'owner',
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "copied_from_id" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_versions" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "summary" VARCHAR(300),
    "asked_by_id" TEXT,
    "asked_by_name" VARCHAR(100),
    "file_key" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifacts_owner_id_updated_at_idx" ON "artifacts"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "artifacts_maker_bot_id_idx" ON "artifacts"("maker_bot_id");

-- CreateIndex
CREATE INDEX "artifacts_expires_at_idx" ON "artifacts"("expires_at");

-- CreateIndex
CREATE INDEX "artifact_versions_asked_by_id_idx" ON "artifact_versions"("asked_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_versions_artifact_id_number_key" ON "artifact_versions"("artifact_id", "number");

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_asked_by_id_fkey" FOREIGN KEY ("asked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
