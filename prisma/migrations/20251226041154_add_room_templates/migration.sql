-- CreateTable
CREATE TABLE "room_template_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_template_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_templates" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_description" TEXT,
    "philosophy" TEXT,
    "purpose" TEXT,
    "who_its_for" TEXT,
    "typical_use_cases" TEXT[],
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "author_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_template_maps" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "map_url" TEXT NOT NULL,
    "preview_image_url" TEXT,
    "size_label" TEXT,
    "orientation" TEXT NOT NULL DEFAULT 'orthogonal',
    "tile_size" INTEGER NOT NULL DEFAULT 32,
    "recommended_world_tags" TEXT[],
    "author_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_template_maps_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN "template_map_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "room_template_categories_slug_key" ON "room_template_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "room_templates_slug_key" ON "room_templates"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "room_template_maps_template_id_slug_key" ON "room_template_maps"("template_id", "slug");

-- CreateIndex
CREATE INDEX "room_template_maps_template_id_idx" ON "room_template_maps"("template_id");

-- AddForeignKey
ALTER TABLE "room_templates" ADD CONSTRAINT "room_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "room_template_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_template_maps" ADD CONSTRAINT "room_template_maps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "room_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_template_map_id_fkey" FOREIGN KEY ("template_map_id") REFERENCES "room_template_maps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

