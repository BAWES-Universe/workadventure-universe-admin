-- Artifact Publish (game #2115): the version the owner published, the title it had then and when.
-- Nullable with no default, so every artifact already shared stays as it is (a link never published shows the latest version)
-- and the change takes no time on a big table.
ALTER TABLE "artifacts" ADD COLUMN "published_version" INTEGER;
ALTER TABLE "artifacts" ADD COLUMN "published_title" VARCHAR(120);
ALTER TABLE "artifacts" ADD COLUMN "published_at" TIMESTAMP(3);
