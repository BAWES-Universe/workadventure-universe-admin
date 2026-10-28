-- Files in bot chats (game #1508): three new tables. Nothing already saved changes, and nothing is brought over: old
-- "[sent a file]" lines kept no file, and artifacts stay in their own tables.

-- CreateTable
CREATE TABLE "bot_files" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "owner_id" TEXT,
    "person_ref" VARCHAR(320),
    "source" VARCHAR(10) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(255),
    "size_bytes" INTEGER,
    "bucket" VARCHAR(255),
    "file_id" VARCHAR(255),
    "url" VARCHAR(2048),
    "line" VARCHAR(300),
    "made_with" VARCHAR(100),
    "made_prompt" TEXT,
    "length_seconds" INTEGER,
    "pages" INTEGER,
    "chat_kind" VARCHAR(20) NOT NULL,
    "chat_ref" VARCHAR(255) NOT NULL,
    "text_state" VARCHAR(10) NOT NULL DEFAULT 'none',
    "text_chars" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_file_parts" (
    "bot_file_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "words" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, regexp_replace(regexp_replace(text, '[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]', '', 'g'), '[[:punct:]]', ' ', 'g'))) STORED,

    CONSTRAINT "bot_file_parts_pkey" PRIMARY KEY ("bot_file_id","number")
);

-- CreateTable
CREATE TABLE "bot_file_counters" (
    "bot_id" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bot_file_counters_pkey" PRIMARY KEY ("bot_id")
);

-- CreateIndex
CREATE INDEX "bot_files_bot_id_owner_id_created_at_idx" ON "bot_files"("bot_id", "owner_id", "created_at");

-- CreateIndex
CREATE INDEX "bot_files_bot_id_chat_kind_chat_ref_idx" ON "bot_files"("bot_id", "chat_kind", "chat_ref");

-- CreateIndex
CREATE INDEX "bot_files_bot_id_person_ref_idx" ON "bot_files"("bot_id", "person_ref");

-- CreateIndex
CREATE INDEX "bot_files_expires_at_idx" ON "bot_files"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "bot_files_bot_id_number_key" ON "bot_files"("bot_id", "number");

-- AddForeignKey
ALTER TABLE "bot_files" ADD CONSTRAINT "bot_files_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_files" ADD CONSTRAINT "bot_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_file_parts" ADD CONSTRAINT "bot_file_parts_bot_file_id_fkey" FOREIGN KEY ("bot_file_id") REFERENCES "bot_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_file_counters" ADD CONSTRAINT "bot_file_counters_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Search by words (game #1508), with Postgres's own word index in 'simple' mode: no extension, and words in any language
-- (Arabic, or a name like "yazoghal") are kept as they are. Arabic short vowels, shadda, sukun and tatweel are left out of
-- the words, so "مَرْحَبًا" and "مرحبا" find each other; the text itself keeps them. Punctuation splits words, as it does
-- in a search: "plan.pdf" is found by "pdf", and "2024-05-01" by "05" (Postgres alone keeps "plan.pdf" whole and
-- "-05" signed). A part's words are worked out once,
-- when it is saved, so a search never reads the text again. The index on a file's name, line and the prompt it was made with is on an expression,
-- which Prisma's schema cannot name, so it lives only here; queries must use the same expression to use it
-- (lib/bot-file-search-sql.ts).
CREATE INDEX "bot_file_parts_words_idx" ON "bot_file_parts" USING GIN ("words");
CREATE INDEX "bot_files_words_idx" ON "bot_files" USING GIN (to_tsvector('simple', regexp_replace(regexp_replace("name" || ' ' || coalesce("line", '') || ' ' || left(coalesce("made_prompt", ''), 20000), '[\u0610-\u061A\u0640\u064B-\u065F\u0670\u06D6-\u06ED]', '', 'g'), '[[:punct:]]', ' ', 'g')));
