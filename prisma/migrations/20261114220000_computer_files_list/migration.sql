-- The list of files on a Brick's computer as of the end of its last job (for the Files list)
ALTER TABLE "brick_computers" ADD COLUMN "files_list" JSONB;
