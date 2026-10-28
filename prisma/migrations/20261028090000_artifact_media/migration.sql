-- The songs, images and videos an artifact version carries (#1510)
ALTER TABLE "artifact_versions" ADD COLUMN "media" JSONB NOT NULL DEFAULT '[]';
