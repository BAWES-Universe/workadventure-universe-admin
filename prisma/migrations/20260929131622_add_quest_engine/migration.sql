-- CreateEnum
CREATE TYPE "quest_scope_type" AS ENUM ('PLATFORM', 'UNIVERSE', 'WORLD', 'ROOM');

-- CreateEnum
CREATE TYPE "quest_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "quest_recurrence" AS ENUM ('ONCE', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "quest_aggregation" AS ENUM ('STATE', 'UNIQUE_SET', 'EVENT_COUNT', 'DURATION', 'COUNTER');

-- CreateEnum
CREATE TYPE "quest_evidence" AS ENUM ('CLIENT', 'MAP_SCRIPT', 'PARTNER', 'SERVER');

-- CreateEnum
CREATE TYPE "quest_credit_timing" AS ENUM ('IMMEDIATE', 'ON_COMPLETION');

-- CreateEnum
CREATE TYPE "quest_progress_status" AS ENUM ('ACCEPTED', 'COMPLETED', 'EXPIRED', 'RETIRED', 'PAUSED', 'STOPPED');

-- CreateEnum
CREATE TYPE "quest_application_outcome" AS ENUM ('ADVANCED', 'SATISFIED', 'COMPLETED', 'DUPLICATE', 'RATE_LIMITED', 'EVIDENCE_TOO_WEAK', 'OUT_OF_BOUNDS');

-- CreateEnum
CREATE TYPE "quest_reward_kind" AS ENUM ('BADGE', 'POINTS');

-- CreateEnum
CREATE TYPE "quest_guidance_state" AS ENUM ('KNOWN', 'DISMISSED');

-- CreateTable
CREATE TABLE "quest_definitions" (
    "id" TEXT NOT NULL,
    "scope_type" "quest_scope_type" NOT NULL,
    "scope_id" TEXT NOT NULL DEFAULT '',
    "key" VARCHAR(64) NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paused_at" TIMESTAMP(3),

    CONSTRAINT "quest_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_versions" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "quest_version_status" NOT NULL DEFAULT 'DRAFT',
    "purpose" VARCHAR(200),
    "title" VARCHAR(80),
    "order" INTEGER NOT NULL DEFAULT 0,
    "recurrence" "quest_recurrence" NOT NULL DEFAULT 'ONCE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "quest_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_objectives" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "action" VARCHAR(64) NOT NULL,
    "aggregation" "quest_aggregation" NOT NULL,
    "evidence" "quest_evidence" NOT NULL DEFAULT 'CLIENT',
    "credit_timing" "quest_credit_timing" NOT NULL DEFAULT 'IMMEDIATE',
    "threshold" INTEGER NOT NULL DEFAULT 1,
    "target" JSONB,
    "any_of_group" VARCHAR(64),
    "required_for_completion" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "quest_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_reward_rules" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "kind" "quest_reward_kind" NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 1,
    "badge_id" VARCHAR(64),
    "evidence" "quest_evidence" NOT NULL DEFAULT 'CLIENT',
    "objective_key" VARCHAR(64),

    CONSTRAINT "quest_reward_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_attempts" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quest_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_progress" (
    "id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "status" "quest_progress_status" NOT NULL DEFAULT 'ACCEPTED',
    "pause_reason" VARCHAR(64),
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "hidden_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quest_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_objective_progress" (
    "id" TEXT NOT NULL,
    "progress_id" TEXT NOT NULL,
    "objective_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "satisfied_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quest_objective_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_observations" (
    "id" TEXT NOT NULL,
    "source" "quest_evidence" NOT NULL,
    "source_id" VARCHAR(64) NOT NULL,
    "event_id" VARCHAR(128) NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "subject" VARCHAR(128),
    "room_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),
    "evidence" JSONB,

    CONSTRAINT "quest_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_observation_applications" (
    "id" TEXT NOT NULL,
    "observation_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "objective_id" TEXT NOT NULL,
    "outcome" "quest_application_outcome" NOT NULL,
    "count_after" INTEGER NOT NULL DEFAULT 0,
    "entity_key" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quest_observation_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_reward_grants" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "observation_id" TEXT,
    "evidence" "quest_evidence" NOT NULL,
    "kind" "quest_reward_kind" NOT NULL,
    "value" INTEGER NOT NULL,
    "badge_id" VARCHAR(64),
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" VARCHAR(200),

    CONSTRAINT "quest_reward_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_tracked_selections" (
    "actor_id" TEXT NOT NULL,
    "progress_id" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quest_tracked_selections_pkey" PRIMARY KEY ("actor_id")
);

-- CreateTable
CREATE TABLE "quest_guidance_preferences" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "capability_key" VARCHAR(64) NOT NULL,
    "state" "quest_guidance_state" NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quest_guidance_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_host_bindings" (
    "id" TEXT NOT NULL,
    "scope_type" "quest_scope_type" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "quest_key" VARCHAR(64) NOT NULL DEFAULT '',
    "host_kind" VARCHAR(16) NOT NULL,
    "host_id" VARCHAR(128) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quest_host_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_partner_links" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "partner_id" VARCHAR(64) NOT NULL,
    "external_subject" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinked_at" TIMESTAMP(3),

    CONSTRAINT "quest_partner_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quest_audit_log" (
    "id" TEXT NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "subject_token" VARCHAR(128) NOT NULL,
    "by_token" VARCHAR(128) NOT NULL,
    "source" VARCHAR(64),
    "rule_id" TEXT,
    "version_id" TEXT,
    "reason" VARCHAR(200),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quest_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quest_definitions_scope_type_scope_id_idx" ON "quest_definitions"("scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_definitions_scope_type_scope_id_key_key" ON "quest_definitions"("scope_type", "scope_id", "key");

-- CreateIndex
CREATE INDEX "quest_versions_definition_id_status_idx" ON "quest_versions"("definition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quest_versions_definition_id_number_key" ON "quest_versions"("definition_id", "number");

-- CreateIndex
CREATE INDEX "quest_objectives_action_idx" ON "quest_objectives"("action");

-- CreateIndex
CREATE UNIQUE INDEX "quest_objectives_version_id_key_key" ON "quest_objectives"("version_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "quest_reward_rules_version_id_key_key" ON "quest_reward_rules"("version_id", "key");

-- CreateIndex
CREATE INDEX "quest_attempts_actor_id_idx" ON "quest_attempts"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_attempts_version_id_actor_id_starts_at_key" ON "quest_attempts"("version_id", "actor_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "quest_progress_attempt_id_key" ON "quest_progress"("attempt_id");

-- CreateIndex
CREATE INDEX "quest_progress_actor_id_status_idx" ON "quest_progress"("actor_id", "status");

-- CreateIndex
CREATE INDEX "quest_progress_definition_id_actor_id_idx" ON "quest_progress"("definition_id", "actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_objective_progress_progress_id_objective_id_key" ON "quest_objective_progress"("progress_id", "objective_id");

-- CreateIndex
CREATE INDEX "quest_observations_actor_id_received_at_idx" ON "quest_observations"("actor_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "quest_observations_source_source_id_event_id_key" ON "quest_observations"("source", "source_id", "event_id");

-- CreateIndex
CREATE INDEX "quest_observation_applications_actor_id_created_at_idx" ON "quest_observation_applications"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quest_observation_applications_observation_id_actor_id_atte_key" ON "quest_observation_applications"("observation_id", "actor_id", "attempt_id", "objective_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_observation_applications_attempt_id_objective_id_enti_key" ON "quest_observation_applications"("attempt_id", "objective_id", "entity_key");

-- CreateIndex
CREATE INDEX "quest_reward_grants_actor_id_badge_id_idx" ON "quest_reward_grants"("actor_id", "badge_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_reward_grants_actor_id_attempt_id_rule_id_key" ON "quest_reward_grants"("actor_id", "attempt_id", "rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_guidance_preferences_actor_id_capability_key_key" ON "quest_guidance_preferences"("actor_id", "capability_key");

-- CreateIndex
CREATE UNIQUE INDEX "quest_host_bindings_scope_type_scope_id_quest_key_key" ON "quest_host_bindings"("scope_type", "scope_id", "quest_key");

-- CreateIndex
CREATE INDEX "quest_partner_links_actor_id_idx" ON "quest_partner_links"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "quest_partner_links_partner_id_external_subject_key" ON "quest_partner_links"("partner_id", "external_subject");

-- CreateIndex
CREATE INDEX "quest_audit_log_subject_token_created_at_idx" ON "quest_audit_log"("subject_token", "created_at");

-- AddForeignKey
ALTER TABLE "quest_versions" ADD CONSTRAINT "quest_versions_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "quest_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_objectives" ADD CONSTRAINT "quest_objectives_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "quest_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_reward_rules" ADD CONSTRAINT "quest_reward_rules_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "quest_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_attempts" ADD CONSTRAINT "quest_attempts_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "quest_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_attempts" ADD CONSTRAINT "quest_attempts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_progress" ADD CONSTRAINT "quest_progress_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "quest_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_progress" ADD CONSTRAINT "quest_progress_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "quest_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_progress" ADD CONSTRAINT "quest_progress_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "quest_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_progress" ADD CONSTRAINT "quest_progress_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_objective_progress" ADD CONSTRAINT "quest_objective_progress_progress_id_fkey" FOREIGN KEY ("progress_id") REFERENCES "quest_progress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_objective_progress" ADD CONSTRAINT "quest_objective_progress_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "quest_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_observations" ADD CONSTRAINT "quest_observations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_observation_applications" ADD CONSTRAINT "quest_observation_applications_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "quest_observations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_observation_applications" ADD CONSTRAINT "quest_observation_applications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_observation_applications" ADD CONSTRAINT "quest_observation_applications_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "quest_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_observation_applications" ADD CONSTRAINT "quest_observation_applications_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "quest_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_observation_applications" ADD CONSTRAINT "quest_observation_applications_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "quest_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_reward_grants" ADD CONSTRAINT "quest_reward_grants_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_reward_grants" ADD CONSTRAINT "quest_reward_grants_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "quest_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_reward_grants" ADD CONSTRAINT "quest_reward_grants_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "quest_reward_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_reward_grants" ADD CONSTRAINT "quest_reward_grants_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "quest_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_reward_grants" ADD CONSTRAINT "quest_reward_grants_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "quest_observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_tracked_selections" ADD CONSTRAINT "quest_tracked_selections_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_tracked_selections" ADD CONSTRAINT "quest_tracked_selections_progress_id_fkey" FOREIGN KEY ("progress_id") REFERENCES "quest_progress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_guidance_preferences" ADD CONSTRAINT "quest_guidance_preferences_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quest_partner_links" ADD CONSTRAINT "quest_partner_links_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
