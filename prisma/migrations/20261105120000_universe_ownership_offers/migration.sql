-- Passing a universe to another account (#820): a table for the waiting offer (one per universe, gone with the universe or either
-- person's account) and two empty columns on universes that say when it was passed on and from whom. Nothing reads them until the
-- offer routes and screens do.

-- AlterTable: when a universe was passed to its owner, and from whom (null for the person who created it)
ALTER TABLE "universes" ADD COLUMN "owner_since" TIMESTAMP(3),
ADD COLUMN "previous_owner_id" TEXT;

-- CreateTable
CREATE TABLE "ownership_offers" (
    "id" TEXT NOT NULL,
    "universe_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "offered_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ownership_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ownership_offers_universe_id_key" ON "ownership_offers"("universe_id");

-- CreateIndex
CREATE INDEX "ownership_offers_to_user_id_idx" ON "ownership_offers"("to_user_id");

-- AddForeignKey
ALTER TABLE "ownership_offers" ADD CONSTRAINT "ownership_offers_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_offers" ADD CONSTRAINT "ownership_offers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_offers" ADD CONSTRAINT "ownership_offers_offered_by_id_fkey" FOREIGN KEY ("offered_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "universes" ADD CONSTRAINT "universes_previous_owner_id_fkey" FOREIGN KEY ("previous_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
