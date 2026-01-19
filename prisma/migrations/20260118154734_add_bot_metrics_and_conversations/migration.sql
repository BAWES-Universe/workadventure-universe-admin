-- CreateTable
CREATE TABLE "bots_metrics" (
    "id" SERIAL NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "metric_type" VARCHAR(50) NOT NULL,
    "metric_value" DECIMAL(15,4) NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bots_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bots_conversations_recent" (
    "id" SERIAL NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "player_id" INTEGER NOT NULL,
    "player_name" VARCHAR(255),
    "messages" JSONB NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "message_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bots_conversations_recent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bots_test_results" (
    "id" SERIAL NOT NULL,
    "test_id" VARCHAR(255) NOT NULL,
    "bot_id" VARCHAR(255),
    "test_suite" VARCHAR(255),
    "results" JSONB NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bots_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bots_memory" (
    "id" SERIAL NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "player_id" INTEGER NOT NULL,
    "player_name" VARCHAR(255),
    "memories" JSONB,
    "emotions" JSONB,
    "last_emotion_update" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bots_metrics_bot_id_timestamp_idx" ON "bots_metrics"("bot_id", "timestamp");

-- CreateIndex
CREATE INDEX "bots_metrics_metric_type_timestamp_idx" ON "bots_metrics"("metric_type", "timestamp");

-- CreateIndex
CREATE INDEX "bots_metrics_timestamp_idx" ON "bots_metrics"("timestamp");

-- CreateIndex
CREATE INDEX "bots_conversations_recent_bot_id_created_at_idx" ON "bots_conversations_recent"("bot_id", "created_at");

-- CreateIndex
CREATE INDEX "bots_conversations_recent_player_id_idx" ON "bots_conversations_recent"("player_id");

-- CreateIndex
CREATE INDEX "bots_conversations_recent_created_at_idx" ON "bots_conversations_recent"("created_at");

-- CreateIndex
CREATE INDEX "bots_conversations_recent_ended_at_idx" ON "bots_conversations_recent"("ended_at");

-- CreateIndex
CREATE INDEX "bots_test_results_bot_id_idx" ON "bots_test_results"("bot_id");

-- CreateIndex
CREATE INDEX "bots_test_results_test_suite_idx" ON "bots_test_results"("test_suite");

-- CreateIndex
CREATE INDEX "bots_test_results_created_at_idx" ON "bots_test_results"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bots_test_results_test_id_key" ON "bots_test_results"("test_id");

-- CreateIndex
CREATE UNIQUE INDEX "bots_memory_bot_id_player_id_key" ON "bots_memory"("bot_id", "player_id");

-- CreateIndex
CREATE INDEX "bots_memory_bot_id_idx" ON "bots_memory"("bot_id");
