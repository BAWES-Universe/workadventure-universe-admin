-- Brick templates (game #2008, Brick 17). A Brick can be shared as a template, and a new Brick can be started from one.
-- Nothing is written for anyone here: no Brick is shared, starred or made from a template until a person does it.
-- A template is a set of immutable versions (what the maker read in the look and shared), never the Brick itself, and never
-- memory, chats, apps, keys, sign-ins, grants, recipients, running goals or tasks, files or a computer.

-- CreateTable
CREATE TABLE "brick_templates" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "maker_id" TEXT NOT NULL,
    "audience" VARCHAR(10) NOT NULL DEFAULT 'everyone',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "choices" JSONB NOT NULL DEFAULT '{}',
    "stopped_at" TIMESTAMP(3),
    "picked_at" TIMESTAMP(3),
    "picked_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brick_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "brick_templates_audience" CHECK ("audience" IN ('everyone', 'link'))
);

-- CreateTable
CREATE TABLE "brick_template_versions" (
    "template_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "character_texture_id" VARCHAR(100),
    "chat_instructions" TEXT,
    "first_thing" VARCHAR(300),
    "needs" JSONB NOT NULL DEFAULT '[]',
    "routines" JSONB NOT NULL DEFAULT '[]',
    "content_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_template_versions_pkey" PRIMARY KEY ("template_id","number")
);

-- CreateTable
CREATE TABLE "brick_template_uses" (
    "bot_id" TEXT NOT NULL,
    "template_id" TEXT,
    "version_number" INTEGER NOT NULL,
    "maker_id" TEXT,
    "maker_name" VARCHAR(100) NOT NULL,
    "template_name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_template_uses_pkey" PRIMARY KEY ("bot_id")
);

-- CreateTable
CREATE TABLE "brick_template_stars" (
    "user_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_template_stars_pkey" PRIMARY KEY ("user_id","template_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brick_templates_bot_id_key" ON "brick_templates"("bot_id");

-- CreateIndex
CREATE INDEX "brick_templates_audience_stopped_at_idx" ON "brick_templates"("audience", "stopped_at");

-- CreateIndex
CREATE INDEX "brick_templates_picked_at_idx" ON "brick_templates"("picked_at");

-- CreateIndex
CREATE INDEX "brick_template_uses_template_id_idx" ON "brick_template_uses"("template_id");

-- CreateIndex
CREATE INDEX "brick_template_stars_template_id_idx" ON "brick_template_stars"("template_id");

-- AddForeignKey
ALTER TABLE "brick_templates" ADD CONSTRAINT "brick_templates_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_templates" ADD CONSTRAINT "brick_templates_maker_id_fkey" FOREIGN KEY ("maker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_templates" ADD CONSTRAINT "brick_templates_picked_by_id_fkey" FOREIGN KEY ("picked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_template_versions" ADD CONSTRAINT "brick_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "brick_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_template_uses" ADD CONSTRAINT "brick_template_uses_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_template_uses" ADD CONSTRAINT "brick_template_uses_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "brick_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_template_uses" ADD CONSTRAINT "brick_template_uses_maker_id_fkey" FOREIGN KEY ("maker_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_template_stars" ADD CONSTRAINT "brick_template_stars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_template_stars" ADD CONSTRAINT "brick_template_stars_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "brick_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
