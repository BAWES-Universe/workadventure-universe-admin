-- What a ready-made App can do, sorted by Universe once per App (lib/app-actions), and an App action's own choice on a Brick's grant
ALTER TABLE "bot_mcp_tools" ADD COLUMN "setting" VARCHAR(20);
ALTER TABLE "bot_mcp_servers" ADD COLUMN "app_actions_version" INTEGER;

CREATE TABLE "app_actions" (
    "id" TEXT NOT NULL,
    "toolkit" VARCHAR(60) NOT NULL,
    "slug" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "heading" VARCHAR(20) NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "catalog_version" VARCHAR(60),
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "app_actions_toolkit_slug_key" ON "app_actions"("toolkit", "slug");
CREATE INDEX "app_actions_toolkit_position_idx" ON "app_actions"("toolkit", "position");
CREATE INDEX "app_actions_source_idx" ON "app_actions"("source");

CREATE TABLE "app_action_catalogs" (
    "toolkit" VARCHAR(60) NOT NULL,
    "refreshed_at" TIMESTAMP(3),
    "claimed_until" TIMESTAMP(3),
    "retry_after" TIMESTAMP(3),
    "action_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "shrunk_since" TIMESTAMP(3),
    "shrunk_reads" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_action_catalogs_pkey" PRIMARY KEY ("toolkit")
);
